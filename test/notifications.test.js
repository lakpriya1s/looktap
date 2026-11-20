import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { NSObject, archive } from '../lib/bplist.js';
import { formatNotification, fromApp, fromPlatters, iosSimNotifications, notificationMatches, parseAndroidNotifications } from '../lib/notifications.js';

// Trimmed from a Samsung on Android 16: a group summary, a two-line text, an ongoing one, a null subText.
const DUMPSYS = `Current Notification Manager state:
  Notification List:
    NotificationRecord(0x0ae5f94a: pkg=com.google.android.googlequicksearchbox user=UserHandle{0} id=0 tag=x importance=1 key=0|g|0|x|10207: Notification(channel=71 flags=GROUP_SUMMARY))
      flags=GROUP_SUMMARY
      key=0|g|0|x|10207
            extras={
                android.title=SpannableString (Google)
                android.text=SpannableString (You have a notification)
            }
      mUpdateTimeMs=1793631947621(2026-11-03 00:05:47.621+0900)
    NotificationRecord(0x0bb837e6: pkg=com.example.shop user=UserHandle{0} id=7 tag=null importance=4 key=0|com.example.shop|7|null|10300: Notification(channel=orders flags=AUTO_CANCEL))
      flags=AUTO_CANCEL
      key=0|com.example.shop|7|null|10300
            extras={
                android.title=String (Order (7) shipped)
                android.subText=null
                android.template=String (android.app.Notification$BigTextStyle)
                android.text=String (Line one (a)
Line two)
                android.showWhen=Boolean (true)
            }
      mCreationTimeMs=1793631000000(2026-11-02 23:50:00.000+0900)
      mUpdateTimeMs=1793632000000(2026-11-03 00:06:40.000+0900)
    NotificationRecord(0x00b2ffce: pkg=android user=UserHandle{-1} id=32 tag=null importance=2 key=-1|android|32|null|1000: Notification(channel=UsbDevNoti flags=ONGOING_EVENT))
      flags=ONGOING_EVENT|CAN_COLORIZE
            extras={
                android.title=String (USB for charging phone)
                android.text=String (Tap for other USB options.)
                android.subText=String (System)
            }
      mUpdateTimeMs=1793630969446(2026-11-02 23:49:29.446+0900)
  TimeoutPendingIntent:
    NotificationRecord(0x1: pkg=not.listed user=UserHandle{0})
            extras={
                android.title=String (Not in the list)
            }
`;

test('Android: dumpsys notification → newest first, summaries skipped, multi-line text kept', () => {
  const list = parseAndroidNotifications(DUMPSYS);
  assert.deepEqual(list.map((n) => n.app), ['com.example.shop', 'android']);
  const [shop, usb] = list;
  assert.equal(shop.title, 'Order (7) shipped');
  assert.equal(shop.body, 'Line one (a)\nLine two');
  assert.equal(shop.subtitle, undefined);
  assert.equal(shop.time.getTime(), 1793632000000);
  assert.equal(shop.ongoing, false);
  assert.equal(shop.channel, 'orders');
  assert.equal(usb.ongoing, true);
  assert.equal(usb.subtitle, 'System');
  assert.deepEqual(parseAndroidNotifications('nothing here'), []);
});

test('iOS simulator: Library.plist maps apps to folders of DeliveredNotifications.plist', () => {
  const home = mkdtempSync(join(tmpdir(), 'looktap-un-'));
  try {
    const dir = join(home, 'Library/UserNotifications');
    const at = (iso) => new NSObject('NSDate', { 'NS.time': (Date.parse(iso) - Date.UTC(2001, 0, 1)) / 1000 });
    mkdirSync(join(dir, 'A1'), { recursive: true });
    mkdirSync(join(dir, 'B2'), { recursive: true });
    writeFileSync(join(dir, 'Library.plist'), archive({ 'com.example.shop': 'A1', 'com.apple.MobileSMS': 'B2', 'com.example.none': 'C3' }));
    writeFileSync(join(dir, 'A1/DeliveredNotifications.plist'), archive([
      { AppNotificationTitle: 'Order 7', AppNotificationSubtitle: 'Shipped', AppNotificationMessage: 'On its way', AppNotificationCreationDate: at('2026-11-02T15:12:42Z'),
        AppNotificationIdentifier: 'X1', AppNotificationBadgeNumber: 3, UNNotificationTriggerType: 'Push', UNNotificationUserInfo: { aps: { badge: 3 }, orderId: 7 } },
    ]));
    writeFileSync(join(dir, 'B2/DeliveredNotifications.plist'), archive([
      { AppNotificationMessage: 'Hello there, this is a longer message', AppNotificationCreationDate: at('2026-11-02T15:20:00Z'), UNNotificationTriggerType: 'TimeInterval' },
    ]));
    const list = iosSimNotifications(home);
    assert.deepEqual(list.map((n) => n.app), ['com.apple.MobileSMS', 'com.example.shop']);
    const shop = list[1];
    assert.equal(shop.title, 'Order 7');
    assert.equal(shop.subtitle, 'Shipped');
    assert.equal(shop.body, 'On its way');
    assert.equal(shop.badge, 3);
    assert.equal(shop.time.toISOString(), '2026-11-02T15:12:42.000Z');
    assert.equal(shop.payload.orderId, 7);
    assert.equal(list[0].trigger, 'TimeInterval');
    assert.deepEqual(iosSimNotifications(join(home, 'missing')), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a real iPhone: platters read off SpringBoard become app, time, title, body', () => {
  const list = fromPlatters([
    { header: 'WISE, Grouped, Yesterday, 23:14, Card payment, 2,425 JPY spent', inner: 'Yesterday, 23:14, Card payment, 2,425 JPY spent', texts: ['Card payment'], body: '2,425 JPY spent', y: 554 },
    { header: 'HEALTH, Yesterday, 23:44, Bedtime Reminder, Your bedtime is set for 0:00.', inner: 'Yesterday, 23:44, Bedtime Reminder, Your bedtime is set for 0:00.', texts: ['Bedtime Reminder'], body: 'Your bedtime is set for 0:00.', y: 357 },
    // the same one again (a stack draws what's behind its top one), and one with no text at all
    { header: 'HEALTH, Yesterday, 23:44, Bedtime Reminder, Your bedtime is set for 0:00.', inner: 'Yesterday, 23:44, Bedtime Reminder, Your bedtime is set for 0:00.', texts: ['Bedtime Reminder'], body: 'Your bedtime is set for 0:00.', y: 360 },
    { header: '', inner: '', texts: [], body: '', y: 10 },
    { header: 'MESSAGES, now, Hi there', inner: 'now, Hi there', texts: [], body: 'Hi there', y: 700 },
  ]);
  assert.deepEqual(list, [
    { app: 'HEALTH', title: 'Bedtime Reminder', body: 'Your bedtime is set for 0:00.', time: 'Yesterday, 23:44' },
    { app: 'WISE', title: 'Card payment', body: '2,425 JPY spent', time: 'Yesterday, 23:14' },
    { app: 'MESSAGES', title: '', body: 'Hi there', time: 'now' },
  ]);
});

test('iOS 16: only the label, so everything after the time is the body', () => {
  const p = (header) => ({ header, inner: '', texts: [], body: '', y: 0 });
  assert.deepEqual(fromPlatters([p('MESSAGES, Grouped, Yesterday 22:38, mRoaming, Dear customer, hello')]), [
    { app: 'MESSAGES', title: '', body: 'mRoaming, Dear customer, hello', time: 'Yesterday 22:38' },
  ]);
  assert.deepEqual(fromPlatters([p('CLOCK, Tuesday, 9:41, Clock, Timer')]), [{ app: 'CLOCK', title: '', body: 'Clock, Timer', time: 'Tuesday, 9:41' }]);
  assert.deepEqual(fromPlatters([p('CLOCK, now')]), []);
});

test('matching text and apps, and the one-line form', () => {
  const n = { app: 'com.example.shop', title: 'Order 7', subtitle: 'Shipped', body: 'On its\nway', time: new Date(1000) };
  assert.ok(notificationMatches(n, 'order 7'));
  assert.ok(notificationMatches(n, 'on its way'));
  assert.ok(notificationMatches(n, 'Shipped On its'));
  assert.ok(!notificationMatches(n, 'refund'));
  assert.ok(fromApp(n, 'example.shop'));
  assert.ok(!fromApp(n, 'com.other'));
  assert.ok(fromApp({ app: 'HEALTH' }, 'com.apple.Health', 'Health'));
  assert.equal(formatNotification(n, 61000), '1m ago    com.example.shop  Order 7 · Shipped: On its ↵ way');
  assert.equal(formatNotification({ app: 'HEALTH', title: '', body: 'Hi', time: 'now' }), 'now       HEALTH  Hi');
  assert.equal(formatNotification({ app: 'android', title: 'USB', body: '', time: new Date(0), ongoing: true }, 3600e3), '1h ago    android  USB  (ongoing)');
});
