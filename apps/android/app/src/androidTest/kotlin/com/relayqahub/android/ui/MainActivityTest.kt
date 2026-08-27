package com.relayqahub.android.ui

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performTextInput
import com.relayqahub.android.MainActivity
import org.junit.Rule
import org.junit.Test

class MainActivityTest {
    @get:Rule
    val composeRule = createAndroidComposeRule<MainActivity>()

    @Test
    fun backendNameIdentityGateAcceptsAName() {
        composeRule.onNodeWithText("输入姓名；未登记的姓名会由后端自动创建账号").assertIsDisplayed()
        composeRule.onNodeWithTag("identity-name").performTextInput("新账号")
        composeRule.onNodeWithTag("identity-login").assertIsDisplayed()
    }
}
