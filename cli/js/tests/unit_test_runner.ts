#!/usr/bin/env -S deno run --reload --allow-run
// Copyright 2018-2020 the Deno authors. All rights reserved. MIT license.
import "./unit_tests.ts";
import {
  readLines,
  permissionCombinations,
  Permissions,
  registerUnitTests,
  SocketReporter,
  fmtPerms,
  parseArgs
} from "./test_util.ts";

interface PermissionSetTestResult {
  perms: Permissions;
  passed: boolean;
  stats: Deno.TestStats;
  permsStr: string;
  duration: number;
  results: Deno.TestResult[];
}

const PERMISSIONS: Deno.PermissionName[] = [
  "read",
  "write",
  "net",
  "env",
  "run",
  "plugin",
  "hrtime"
];

/**
 * Take a list of permissions and revoke missing permissions.
 */
async function dropWorkerPermissions(
  requiredPermissions: Deno.PermissionName[]
): Promise<void> {
  const permsToDrop = PERMISSIONS.filter((p): boolean => {
    return !requiredPermissions.includes(p);
  });

  for (const perm of permsToDrop) {
    await Deno.permissions.revoke({ name: perm });
  }
}

async function workerRunnerMain(
  addrStr: string,
  permsStr: string,
  filter?: string
): Promise<void> {
  const [hostname, port] = addrStr.split(":");
  const addr = { hostname, port: Number(port) };

  let perms: Deno.PermissionName[] = [];
  if (permsStr.length > 0) {
    perms = permsStr.split(",") as Deno.PermissionName[];
  }
  // Setup reporter
  const conn = await Deno.connect(addr);
  const socketReporter = new SocketReporter(conn);
  // Drop current process permissions to requested set
  await dropWorkerPermissions(perms);
  // Register unit tests that match process permissions
  await registerUnitTests();
  // Execute tests
  await Deno.runTests({
    failFast: false,
    exitOnFail: false,
    reporter: socketReporter,
    only: filter
  });
  // Notify parent process we're done
  socketReporter.close();
}

function spawnWorkerRunner(
  verbose: boolean,
  addr: string,
  perms: Permissions,
  filter?: string
): Deno.Process {
  // run subsequent tests using same deno executable
  const permStr = Object.keys(perms)
    .filter((permName): boolean => {
      return perms[permName as Deno.PermissionName] === true;
    })
    .join(",");

  const args = [
    Deno.execPath(),
    "run",
    "-A",
    "cli/js/tests/unit_test_runner.ts",
    "--worker",
    `--addr=${addr}`,
    `--perms=${permStr}`
  ];

  if (filter) {
    args.push("--");
    args.push(filter);
  }

  const ioMode = verbose ? "inherit" : "null";

  const p = Deno.run({
    args,
    stdin: ioMode,
    stdout: ioMode,
    stderr: ioMode
  });

  return p;
}

async function runTestsForPermissionSet(
  verbose: boolean,
  reporter: Deno.ConsoleTestReporter,
  perms: Permissions,
  filter?: string
): Promise<PermissionSetTestResult> {
  const permsFmt = fmtPerms(perms);
  console.log(`Running tests for: ${permsFmt}`);
  const addr = { hostname: "127.0.0.1", port: 4510 };
  const addrStr = `${addr.hostname}:${addr.port}`;
  const workerListener = Deno.listen(addr);

  const workerProcess = spawnWorkerRunner(verbose, addrStr, perms, filter);

  // Wait for worker subprocess to go online
  const conn = await workerListener.accept();

  let err;
  let hasThrown = false;
  let expectedPassedTests;
  let endEvent;

  try {
    for await (const line of readLines(conn)) {
      const msg = JSON.parse(line);

      if (msg.kind === Deno.TestEvent.Start) {
        expectedPassedTests = msg.tests;
        await reporter.start(msg);
        continue;
      } else if (msg.kind === Deno.TestEvent.TestStart) {
        await reporter.testStart(msg);
        continue;
      } else if (msg.kind === Deno.TestEvent.TestEnd) {
        await reporter.testEnd(msg);
        continue;
      } else {
        endEvent = msg;
        await reporter.end(msg);
        break;
      }
    }
  } catch (e) {
    hasThrown = true;
    err = e;
  } finally {
    workerListener.close();
  }

  if (hasThrown) {
    throw err;
  }

  if (typeof expectedPassedTests === "undefined") {
    throw new Error("Worker runner didn't report start");
  }

  if (typeof endEvent === "undefined") {
    throw new Error("Worker runner didn't report end");
  }

  const workerStatus = await workerProcess.status();
  if (!workerStatus.success) {
    throw new Error(
      `Worker runner exited with status code: ${workerStatus.code}`
    );
  }

  workerProcess.close();

  const passed =
    expectedPassedTests === endEvent.stats.passed + endEvent.stats.ignored;

  return {
    perms,
    passed,
    permsStr: permsFmt,
    duration: endEvent.duration,
    stats: endEvent.stats,
    results: endEvent.results
  };
}

async function masterRunnerMain(
  verbose: boolean,
  filter?: string
): Promise<void> {
  console.log(
    "Discovered permission combinations for tests:",
    permissionCombinations.size
  );

  for (const perms of permissionCombinations.values()) {
    console.log("\t" + fmtPerms(perms));
  }

  const testResults = new Set<PermissionSetTestResult>();
  const consoleReporter = new Deno.ConsoleTestReporter();

  for (const perms of permissionCombinations.values()) {
    const result = await runTestsForPermissionSet(
      verbose,
      consoleReporter,
      perms,
      filter
    );
    testResults.add(result);
  }

  // if any run tests returned non-zero status then whole test
  // run should fail
  let testsPassed = true;

  for (const testResult of testResults) {
    const { permsStr, stats, duration, results } = testResult;
    console.log(`Summary for ${permsStr}`);
    await consoleReporter.end({
      kind: Deno.TestEvent.End,
      stats,
      duration,
      results
    });
    testsPassed = testsPassed && testResult.passed;
  }

  if (!testsPassed) {
    console.error("Unit tests failed");
    Deno.exit(1);
  }

  console.log("Unit tests passed");
}

const HELP = `Unit test runner

Run tests matching current process permissions:

  deno --allow-write unit_test_runner.ts

  deno --allow-net --allow-hrtime unit_test_runner.ts

  deno --allow-write unit_test_runner.ts -- testWriteFile

Run "master" process that creates "worker" processes
for each discovered permission combination:

  deno -A unit_test_runner.ts --master

Run worker process for given permissions:

  deno -A unit_test_runner.ts --worker --perms=net,read,write --addr=127.0.0.1:4500


OPTIONS:
  --master 
    Run in master mode, spawning worker processes for
    each discovered permission combination
    
  --worker 
    Run in worker mode, requires "perms" and "addr" flags,
    should be run with "-A" flag; after setup worker will
    drop permissions to required set specified in "perms"

  --perms=<perm_name>...
    Set of permissions this process should run tests with,

  --addr=<addr>
    Address of TCP socket for reporting

ARGS:
  -- <filter>... 
    Run only tests with names matching filter, must
    be used after "--"
`;

function assertOrHelp(expr: unknown): asserts expr {
  if (!expr) {
    console.log(HELP);
    Deno.exit(1);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(Deno.args, {
    boolean: ["master", "worker", "verbose"],
    "--": true
  });

  if (args.help) {
    console.log(HELP);
    return;
  }

  const filter = args["--"][0];

  // Master mode
  if (args.master) {
    return await masterRunnerMain(args.verbose, filter);
  }

  // Worker mode
  if (args.worker) {
    assertOrHelp(typeof args.addr === "string");
    assertOrHelp(typeof args.perms === "string");
    return await workerRunnerMain(args.addr, args.perms, filter);
  }

  // Running tests matching current process permissions
  await registerUnitTests();
  await Deno.runTests({
    failFast: false,
    exitOnFail: true,
    only: filter
  });
}

main();
