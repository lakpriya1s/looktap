package com.looktap.wifi;

import android.app.job.JobParameters;
import android.app.job.JobService;

/** Receiver's jobs: re-arm the job that watches the setting, then look at Wireless debugging (off the main thread). */
public class Keeper extends JobService {
    @Override
    public boolean onStartJob(final JobParameters params) {
        Receiver.schedule(this);
        new Thread(new Runnable() {
            @Override
            public void run() {
                Receiver.check(Keeper.this);
                jobFinished(params, false);
            }
        }, "looktap-wifi").start();
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        return false;
    }
}
