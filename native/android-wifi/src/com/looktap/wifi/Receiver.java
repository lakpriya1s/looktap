package com.looktap.wifi;

import android.app.job.JobInfo;
import android.app.job.JobScheduler;
import android.content.BroadcastReceiver;
import android.content.ComponentName;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.provider.Settings;
import android.util.Log;

/**
 Keeps Wireless debugging on. Android switches it off when the phone restarts and when it leaves Wi-Fi; this turns
 it back on once the phone is on Wi-Fi again, even before the first unlock after a restart. It does nothing while USB
 debugging is off, and it leaves Wireless debugging off for the rest of a Wi-Fi connection on which someone turned it
 off, or declined Android's "Allow wireless debugging on this network?": it never nags.

 The receiver (boot, update, `looktap wifi --always`'s ARM) only schedules; Keeper does the work. Jobs:
 - CHANGED: whenever the setting changes (Wi-Fi lost, a person, Android itself); re-armed after each run.
 - WIFI: as soon as Wi-Fi is up (optionally after a delay, for a retry).
 - PERIODIC: every 15 minutes on Wi-Fi, persisted: a backstop that outlasts a restart even without a boot broadcast.
 */
public class Receiver extends BroadcastReceiver {
    static final String TAG = "looktap-wifi";
    static final String SETTING = "adb_wifi_enabled";
    static final int WIFI = 1, PERIODIC = 2, CHANGED = 3;
    /** Android turning it straight back off (Wi-Fi not settled yet, e.g. just after boot): try again, this often. */
    static final int RETRIES = 3;
    static final long RETRY_AFTER_MS = 10000, BOUNCE_MS = 2000;

    @Override
    public void onReceive(Context c, Intent intent) {
        schedule(c);
        whenWifi(c, 0);
    }

    static SharedPreferences prefs(Context c) {
        // Device-protected storage: readable before the first unlock after a restart.
        return c.createDeviceProtectedStorageContext().getSharedPreferences("keeper", Context.MODE_PRIVATE);
    }

    static ComponentName keeper(Context c) {
        return new ComponentName(c, Keeper.class);
    }

    static NetworkRequest wifiRequest() {
        return new NetworkRequest.Builder().addTransportType(NetworkCapabilities.TRANSPORT_WIFI).build();
    }

    /** The jobs that always exist: CHANGED (re-armed every time) and PERIODIC (scheduled once). */
    static void schedule(Context c) {
        try {
            JobScheduler js = c.getSystemService(JobScheduler.class);
            js.schedule(new JobInfo.Builder(CHANGED, keeper(c))
                    .addTriggerContentUri(new JobInfo.TriggerContentUri(Settings.Global.getUriFor(SETTING), 0))
                    .setTriggerContentUpdateDelay(1000).setTriggerContentMaxDelay(5000).build());
            if (js.getPendingJob(PERIODIC) == null)
                js.schedule(new JobInfo.Builder(PERIODIC, keeper(c)).setRequiredNetwork(wifiRequest())
                        .setPeriodic(15 * 60 * 1000L).setPersisted(true).build());
        } catch (RuntimeException e) {
            Log.w(TAG, "couldn't schedule", e);
        }
    }

    /** Run Keeper once Wi-Fi is up, no sooner than `delayMs` from now. */
    static void whenWifi(Context c, long delayMs) {
        try {
            JobInfo.Builder b = new JobInfo.Builder(WIFI, keeper(c)).setRequiredNetwork(wifiRequest());
            if (delayMs > 0) b.setMinimumLatency(delayMs);
            c.getSystemService(JobScheduler.class).schedule(b.build());
        } catch (RuntimeException e) {
            Log.w(TAG, "couldn't schedule", e);
        }
    }

    /**
     On Wi-Fi with it off: turn it on, the first time on this Wi-Fi connection (or for a retry). Off again later on
     the same connection means someone turned it off or declined the prompt: leave it until the next connection.
     Blocks up to BOUNCE_MS to see whether Android switched it straight back off; call it off the main thread.
     */
    static void check(Context c) {
        ContentResolver cr = c.getContentResolver();
        try {
            if (Settings.Global.getInt(cr, "adb_enabled", 0) != 1) return; // USB debugging off: the user's choice
            SharedPreferences p = prefs(c);
            // A restart numbers networks afresh: forget the connection seen before it.
            int boot = Settings.Global.getInt(cr, "boot_count", 0);
            if (p.getInt("boot", -1) != boot) p.edit().clear().putInt("boot", boot).apply();
            Network wifi = wifiNetwork(c);
            boolean on = Settings.Global.getInt(cr, SETTING, 0) == 1;
            if (wifi == null) {
                if (!on) whenWifi(c, 0);
                return;
            }
            long id = wifi.getNetworkHandle();
            if (on) {
                p.edit().putLong("seen", id).putBoolean("retry", false).apply();
                return;
            }
            boolean fresh = p.getLong("seen", 0) != id;
            if (!fresh && !p.getBoolean("retry", false)) return; // turned off on this connection: leave it
            int tries = fresh ? 1 : p.getInt("tries", 0) + 1;
            p.edit().putLong("seen", id).putInt("tries", tries).putBoolean("retry", false).commit();
            Settings.Global.putInt(cr, SETTING, 1);
            Log.i(TAG, "Wireless debugging on (try " + tries + ")");
            Thread.sleep(BOUNCE_MS);
            if (Settings.Global.getInt(cr, SETTING, 0) == 1 || tries >= RETRIES) return;
            // Off again at once: Android, not a person (nobody answers a prompt that fast). Try again shortly.
            Log.i(TAG, "Android switched it straight back off; trying again in " + RETRY_AFTER_MS / 1000 + " s");
            p.edit().putBoolean("retry", true).commit();
            whenWifi(c, RETRY_AFTER_MS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } catch (RuntimeException e) {
            // SecurityException: WRITE_SECURE_SETTINGS not granted (looktap wifi --always grants it)
            Log.w(TAG, "couldn't turn Wireless debugging on", e);
        }
    }

    static Network wifiNetwork(Context c) {
        ConnectivityManager cm = c.getSystemService(ConnectivityManager.class);
        for (Network n : cm.getAllNetworks()) {
            NetworkCapabilities caps = cm.getNetworkCapabilities(n);
            if (caps != null && caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) return n;
        }
        return null;
    }
}
