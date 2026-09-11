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
    fun projectCodeIdentityGateAcceptsThreeFields() {
        composeRule.onNodeWithText("填写项目名称、四位项目码和姓名即可登记；项目码中的前导零会保留。").assertIsDisplayed()
        composeRule.onNodeWithTag("identity-project-name").performTextInput("Demo Project")
        composeRule.onNodeWithTag("identity-project-code").performTextInput("0007")
        composeRule.onNodeWithTag("identity-name").performTextInput("新账号")
        composeRule.onNodeWithTag("identity-login").assertIsDisplayed()
    }
}
