// Start an installed XCUITest runner the way `xcodebuild test-without-building` does, without Xcode: for iPhones on
// iOS 16 and older, which Xcode 27 no longer talks to. Two testmanagerd connections (a control session and the test
// session) and one to instruments, which launches the runner; the runner then asks for its test configuration, and
// runs its one test (looktap's server) for as long as these connections stay open. Run as a script, it keeps them
// open in the background and logs as xcodebuild would, so the driver reads its progress the same way.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { NSObject, nsURL, nsUUID } from './bplist.js';
import { I32, INSTRUMENTS, TESTMANAGERD, dtxService } from './dtx.js';
import { installedApps } from './devservices.js';

const PROTOCOL = 36; // Xcode's testmanagerd protocol version; iOS 16 accepts it
const IDE_DAEMON = 'dtxproxy:XCTestManager_IDEInterface:XCTestManager_DaemonConnectionInterface';

/** The test configuration the runner asks for: which bundle to load, under which session. */
export function testConfiguration({ runnerPath, module, session }) {
  return new NSObject('XCTestConfiguration', {
    aggregateStatisticsBeforeCrash: { XCSuiteRecordsKey: {} },
    automationFrameworkPath: '/Developer/Library/PrivateFrameworks/XCTAutomationSupport.framework',
    baselineFileRelativePath: null,
    baselineFileURL: null,
    defaultTestExecutionTimeAllowance: null,
    disablePerformanceMetrics: false,
    emitOSLogs: false,
    formatVersion: 2,
    gatherLocalizableStringsData: false,
    initializeForUITesting: true,
    maximumTestExecutionTimeAllowance: null,
    productModuleName: module,
    randomExecutionOrderingSeed: null,
    reportActivities: true,
    reportResultsToIDE: true,
    sessionIdentifier: nsUUID(session),
    systemAttachmentLifetime: 2,
    targetApplicationArguments: [],
    targetApplicationBundleID: null,
    targetApplicationEnvironment: null,
    targetApplicationPath: '/whatever-it-does-not-matter/but-should-not-be-empty',
    testApplicationDependencies: null,
    testApplicationUserOverrides: null,
    testBundleRelativePath: null,
    testBundleURL: nsURL(`file://${runnerPath}/PlugIns/${module}.xctest`),
    testExecutionOrdering: 0,
    testTimeoutsEnabled: false,
    testsDrivenByIDE: false,
    testsMustRunOnMainThread: true,
    testsToRun: null,
    testsToSkip: null,
    treatMissingBaselinesAsFailures: false,
    userAttachmentLifetime: 0,
    preferredScreenCaptureFormat: 2,
    IDECapabilities: new NSObject('XCTCapabilities', {
      'capabilities-dictionary': {
        'expected failure test capability': true,
        'test case run configurations': true,
        'test timeout capability': true,
        'test iterations': true,
        'request diagnostics for specific devices': true,
        'delayed attachment transfer': true,
        'skipped test capability': true,
        'daemon container sandbox extension': true,
        'ubiquitous test identifiers': true,
        'XCTIssue capability': true,
      },
    }),
  });
}

/**
 Start runner `bundleId` (an installed `<name>-Runner.app`) with `env` and keep it running until it ends or a connection
 drops. `log(line)` hears what xcodebuild would print. Resolves when the session is over.
 */
export async function runTests(udid, bundleId, { env = {}, log = console.log } = {}) {
  const [runner] = await installedApps(udid, { ids: [bundleId] });
  if (!runner) throw new Error(`the runner (${bundleId}) is not installed on the device`);
  const module = runner.CFBundleExecutable.replace(/-Runner$/, '');
  const session = randomUUID().toUpperCase();
  const config = testConfiguration({ runnerPath: runner.Path, module, session });
  const debug = process.env.LOOKTAP_DEBUG ? (s) => log(s) : undefined;

  const dvt = await dtxService(udid, INSTRUMENTS, { log: debug });
  const ctrl = await dtxService(udid, TESTMANAGERD, { log: debug });
  const main = await dtxService(udid, TESTMANAGERD, { log: debug });
  const all = [dvt, ctrl, main];
  const over = new Promise((resolve) => {
    for (const d of all) d.onClose((e) => resolve(`connection closed: ${e.message}`));
    const said = (selector, fn) => main.handle(selector, fn);
    said('_XCT_testRunnerReadyWithCapabilities:', () => (log('Runner ready: sending its test configuration'), config));
    said('_XCT_logDebugMessage:', (m) => log(String(m).trimEnd()));
    said('_XCT_logMessage:', (m) => log(String(m).trimEnd()));
    said('_XCT_didBeginExecutingTestPlan', () => log('Test plan started'));
    said('_XCT_testCaseDidStartForTestClass:method:', (c, m) => log(`Test Case '-[${c} ${m}]' started.`));
    said('_XCT_testCaseDidFailForTestClass:method:withMessage:file:line:', (c, m, msg, file, line) => log(`${file}:${line}: error: -[${c} ${m}] : ${msg}`));
    said('_XCT_testCaseDidFinishForTestClass:method:withStatus:duration:', (c, m, status, t) => log(`Test Case '-[${c} ${m}]' ${status} (${Number(t).toFixed(3)} seconds).`));
    said('_XCT_initializationForUITestingDidFailWithError:', (e) => log(`Testing failed: ${e?.userInfo?.NSLocalizedDescription || JSON.stringify(e)}`));
    said('_XCT_didFailToBootstrapWithError:', (e) => log(`Testing failed: ${e?.userInfo?.NSLocalizedDescription || JSON.stringify(e)}`));
    said('_XCT_didFinishExecutingTestPlan', () => resolve('test plan finished'));
    dvt.handle('outputReceived:fromProcess:atTime:', (out) => log(String(out).trimEnd()));
  });

  try {
    const ctrlCh = await ctrl.open(IDE_DAEMON);
    const mainCh = await main.open(IDE_DAEMON);
    await ctrl.call(ctrlCh, '_IDE_initiateControlSessionWithProtocolVersion:', [PROTOCOL]);
    await main.call(mainCh, '_IDE_initiateSessionWithIdentifier:forClient:atPath:protocolVersion:', [nsUUID(session), 'looktap', '/Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild', PROTOCOL]);

    // The driver channel: the runner opens it once it's up; the test plan starts on it.
    const driver = new Promise((resolve) => main.onChannel((code, id) => id.includes('XCTestDriverInterface') && resolve(code)));

    const proc = await dvt.open('com.apple.instruments.server.services.processcontrol');
    const appEnv = {
      CA_ASSERT_MAIN_THREAD_TRANSACTIONS: '0',
      CA_DEBUG_TRANSACTIONS: '0',
      DYLD_FRAMEWORK_PATH: `${runner.Path}/Frameworks:`,
      DYLD_LIBRARY_PATH: `${runner.Path}/Frameworks`,
      MTC_CRASH_ON_REPORT: '1',
      NSUnbufferedIO: 'YES',
      SQLITE_ENABLE_THREAD_ASSERTIONS: '1',
      XCTestBundlePath: `${runner.Path}/PlugIns/${module}.xctest`,
      XCTestConfigurationFilePath: `${runner.Container}/tmp/${session}.xctestconfiguration`,
      XCODE_DBG_XPC_EXCLUSIONS: 'com.apple.dt.xctestSymbolicator',
      XCTestSessionIdentifier: session,
      DYLD_INSERT_LIBRARIES: '/Developer/usr/lib/libMainThreadChecker.dylib',
      OS_ACTIVITY_DT_MODE: 'YES',
      ...env,
    };
    const args = ['-NSTreatUnknownArgumentsAsOpen', 'NO', '-ApplePersistenceIgnoreState', 'YES'];
    const pid = await dvt.call(proc, 'launchSuspendedProcessWithDevicePath:bundleIdentifier:environment:arguments:options:', ['', bundleId, appEnv, args, { StartSuspendedKey: false, ActivateSuspended: true }]);
    log(`Runner launched: pid ${pid}`);
    await new Promise((r) => setTimeout(r, 1000));
    await ctrl.call(ctrlCh, '_IDE_authorizeTestSessionWithProcessID:', [pid]);

    const code = await Promise.race([driver, new Promise((r) => setTimeout(() => r(null), 60000)), over.then(() => null)]);
    if (code == null) throw new Error('the runner never connected back to testmanagerd (see the device log)');
    await main.call(code, '_IDE_startExecutingTestPlanWithProtocolVersion:', [PROTOCOL], { timeout: 120000 });
    const why = await over;
    log(`Test session ended: ${why}`);
    if (!dvt.closed) await dvt.call(proc, 'killPid:', [new I32(pid)], { reply: false }).catch(() => {});
  } finally {
    for (const d of all) d.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  // node xctest.js <udid> <runner bundle id> [KEY=VALUE…]: the environment is the runner's.
  const [udid, bundleId, ...pairs] = process.argv.slice(2);
  const env = Object.fromEntries(pairs.map((p) => [p.slice(0, p.indexOf('=')), p.slice(p.indexOf('=') + 1)]));
  const stamp = () => new Date().toISOString().slice(11, 23);
  runTests(udid, bundleId, { env, log: (l) => console.log(`${stamp()} ${l}`) }).then(
    () => process.exit(0),
    (e) => (console.log(`Testing failed:\n\t${e.message}`), process.exit(1)),
  );
}
