package com.relayqahub.android.ui

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import com.relayqahub.android.MainActivity
import org.junit.Rule
import org.junit.Test

class MainActivityTest {
    @get:Rule
    val composeRule = createAndroidComposeRule<MainActivity>()

    @Test
    fun pinyinIdentityGateOpensTheThreePageApp() {
        composeRule.onNodeWithText("输入姓名拼音识别身份").assertIsDisplayed()
        composeRule.onNodeWithTag("identity-pinyin").performTextInput("luodongle")
        composeRule.onNodeWithTag("identity-login").performClick()

        composeRule.onNodeWithTag("app-title").assertIsDisplayed()
        composeRule.onNodeWithTag("switch-identity").assertIsDisplayed()
        composeRule.onNodeWithTag("nav-capture-settings").assertIsDisplayed()
        composeRule.onNodeWithTag("nav-new-bug").assertIsDisplayed()
        composeRule.onNodeWithTag("nav-bug-list").assertIsDisplayed()

        composeRule.onNodeWithTag("bug-list-page").assertIsDisplayed()
        composeRule.onNodeWithTag("filter-reporter").assertIsDisplayed()
        composeRule.onNodeWithTag("filter-owner").assertIsDisplayed()
        composeRule.onNodeWithTag("filter-state").assertIsDisplayed()
        composeRule.onNodeWithTag("show-all-bugs").assertIsDisplayed()

        composeRule.onNodeWithTag("nav-capture-settings").performClick()
        composeRule.onNodeWithTag("capture-settings-page").assertIsDisplayed()
        composeRule.onNodeWithTag("start-capture").assertIsDisplayed()

        composeRule.onNodeWithTag("nav-new-bug").performClick()
        composeRule.onNodeWithTag("bug-content").performScrollTo().assertIsDisplayed()
    }
}
