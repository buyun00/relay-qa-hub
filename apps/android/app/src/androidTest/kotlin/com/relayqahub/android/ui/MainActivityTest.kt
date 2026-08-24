package com.relayqahub.android.ui

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performScrollTo
import com.relayqahub.android.MainActivity
import org.junit.Rule
import org.junit.Test

class MainActivityTest {
    @get:Rule
    val composeRule = createAndroidComposeRule<MainActivity>()

    @Test
    fun nativeFoundationScreenIsRunnable() {
        composeRule.onNodeWithTag("app-title").assertIsDisplayed()
        composeRule.onNodeWithText("Native Android foundation").assertIsDisplayed()
        composeRule.onNodeWithText(
            "Jetpack Compose UI — no WebView, PWA, or service worker.",
        ).assertIsDisplayed()
        composeRule.onNodeWithTag("queue-draft").performScrollTo().assertIsDisplayed()
    }
}
