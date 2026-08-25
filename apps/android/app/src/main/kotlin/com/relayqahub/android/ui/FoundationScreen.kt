package com.relayqahub.android.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.relayqahub.android.FoundationUiState
import com.relayqahub.android.FoundationViewModel

@Composable
fun FoundationScreen(viewModel: FoundationViewModel) {
    val state = viewModel.uiState.collectAsStateWithLifecycle().value
    FoundationScreen(
        state = state,
        onQueueDraft = viewModel::queueLocalDraft,
        onRunLiveSmoke = viewModel::runLiveSmoke,
    )
}

@Composable
internal fun FoundationScreen(
    state: FoundationUiState,
    onQueueDraft: () -> Unit,
    onRunLiveSmoke: () -> Unit,
) {
    Scaffold(
        modifier = Modifier
            .fillMaxSize()
            .windowInsetsPadding(WindowInsets.safeDrawing),
        containerColor = MaterialTheme.colorScheme.background,
    ) { innerPadding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding)
                .padding(horizontal = 20.dp)
                .verticalScroll(rememberScrollState())
                .navigationBarsPadding()
                .testTag("foundation-screen"),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Spacer(Modifier.size(6.dp))
            Text(
                text = "Relay QA Hub",
                style = MaterialTheme.typography.headlineMedium,
                fontWeight = FontWeight.Bold,
                modifier = Modifier.testTag("app-title"),
            )
            Text(
                text = "Native Android foundation",
                style = MaterialTheme.typography.titleMedium,
                color = MaterialTheme.colorScheme.primary,
            )
            Text(
                text = "Jetpack Compose UI — no WebView, PWA, or service worker.",
                style = MaterialTheme.typography.bodyMedium,
            )

            ScopeCard(state)

            FoundationCard(
                title = "Local isolation",
                detail = "Room cache and queue keys include both account and project.",
                value = "${state.cachedItemCount} cached • ${state.queuedOperationCount} queued",
            )
            FoundationCard(
                title = "Constrained delivery",
                detail = "WorkManager uses connected-network, battery, unique-work, and exponential backoff gates.",
                value = "4-run retry ceiling",
            )
            FoundationCard(
                title = "Credential boundary",
                detail = "Opaque native session credentials stay outside Room and are encrypted with Android Keystore.",
                value = state.credentialBoundary,
            )
            FoundationCard(
                title = "Versioned QA Hub API",
                detail = "Queued and live JSON writes share the additive App-first vendor media type and contract boundary.",
                value = "Contract ${state.contractVersion}",
            )

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                OutlinedButton(
                    onClick = onQueueDraft,
                    modifier = Modifier
                        .weight(1f)
                        .testTag("queue-draft"),
                ) {
                    Text("Queue draft")
                }
                Button(
                    onClick = onRunLiveSmoke,
                    modifier = Modifier
                        .weight(1f)
                        .testTag("live-smoke"),
                ) {
                    Text("Run live smoke")
                }
            }

            Surface(
                color = MaterialTheme.colorScheme.primaryContainer,
                shape = RoundedCornerShape(12.dp),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(
                    text = state.lastAction,
                    modifier = Modifier
                        .padding(14.dp)
                        .testTag("last-action"),
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
            Spacer(Modifier.size(16.dp))
        }
    }
}
@Composable
private fun ScopeCard(state: FoundationUiState) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.primaryContainer,
        ),
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Text(
                text = "Current local scope",
                style = MaterialTheme.typography.labelLarge,
            )
            Text(
                text = state.accountName,
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
            )
            Text(text = state.projectName, style = MaterialTheme.typography.bodyMedium)
        }
    }
}

@Composable
private fun FoundationCard(
    title: String,
    detail: String,
    value: String,
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Text(
                text = title,
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
            )
            Text(text = detail, style = MaterialTheme.typography.bodyMedium)
            Text(
                text = value,
                style = MaterialTheme.typography.labelLarge,
                color = MaterialTheme.colorScheme.secondary,
            )
        }
    }
}
