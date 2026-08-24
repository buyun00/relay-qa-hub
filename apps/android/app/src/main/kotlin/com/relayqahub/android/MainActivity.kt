package com.relayqahub.android

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.viewmodel.compose.viewModel
import com.relayqahub.android.ui.FoundationScreen
import com.relayqahub.android.ui.QaHubTheme
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            QaHubTheme {
                val foundationViewModel: FoundationViewModel = viewModel()
                FoundationScreen(viewModel = foundationViewModel)
            }
        }
    }

    override fun onResume() {
        super.onResume()
        // Unlocking the device resumes the foreground activity. Re-enqueue fail-closed
        // keystore operations here so BLOCKED_DEVICE never relies on an implicit retry.
        lifecycleScope.launch {
            (application as QaHubApplication).container.deviceSecurityResume
                .resumeBlockedOperations()
        }
    }
}
