package com.relayqahub.android

import android.app.Application
import android.util.Log
import androidx.work.Configuration

class QaHubApplication : Application(), Configuration.Provider {
    lateinit var container: AppContainer
        private set

    override val workManagerConfiguration: Configuration
        get() = Configuration.Builder()
            .setMinimumLoggingLevel(if (BuildConfig.DEBUG) Log.INFO else Log.ERROR)
            .build()

    override fun onCreate() {
        super.onCreate()
        container = AppContainer.create(this)
    }
}
