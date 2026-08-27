package com.relayqahub.android.ui

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** Shared Android palette derived from the approved Web workbench. */
internal val QaForest = Color(0xFF172B21)
internal val QaLime = Color(0xFFB9F34A)
internal val QaCanvas = Color(0xFFF3F6F2)
internal val QaInk = Color(0xFF17231D)
internal val QaMuted = Color(0xFF68746D)
internal val QaLine = Color(0xFFDFE6DF)

private val LightColors = lightColorScheme(
    primary = QaForest,
    onPrimary = Color.White,
    primaryContainer = QaLime,
    onPrimaryContainer = QaForest,
    secondary = Color(0xFF4978E8),
    onSecondary = Color.White,
    secondaryContainer = Color(0xFFEAF1FF),
    onSecondaryContainer = Color(0xFF244B9A),
    tertiary = Color(0xFFFF7B31),
    onTertiary = Color.White,
    tertiaryContainer = Color(0xFFFFEDE2),
    onTertiaryContainer = Color(0xFF8C370B),
    background = QaCanvas,
    onBackground = QaInk,
    surface = Color.White,
    onSurface = QaInk,
    surfaceVariant = Color(0xFFF7F9F7),
    onSurfaceVariant = QaMuted,
    outline = Color(0xFFB8C3BB),
    outlineVariant = QaLine,
    error = Color(0xFFC33D3D),
    errorContainer = Color(0xFFFFE8E7),
    onErrorContainer = Color(0xFF7B1E20),
)

private val DarkColors = darkColorScheme(
    primary = QaLime,
    onPrimary = QaForest,
    primaryContainer = Color(0xFF2B4437),
    onPrimaryContainer = Color(0xFFD9FF92),
    secondary = Color(0xFFB5C8FF),
    tertiary = Color(0xFFFFB58A),
    background = Color(0xFF111813),
    onBackground = Color(0xFFF0F5F1),
    surface = Color(0xFF19221C),
    onSurface = Color(0xFFF0F5F1),
    surfaceVariant = Color(0xFF222D26),
    onSurfaceVariant = Color(0xFFBAC5BD),
    outline = Color(0xFF859188),
    outlineVariant = Color(0xFF344139),
)

private val QaTypography = Typography(
    displaySmall = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.Bold,
        fontSize = 36.sp,
        lineHeight = 43.sp,
        letterSpacing = (-0.5).sp,
    ),
    headlineLarge = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.Bold,
        fontSize = 30.sp,
        lineHeight = 37.sp,
    ),
    headlineMedium = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.Bold,
        fontSize = 25.sp,
        lineHeight = 32.sp,
    ),
    headlineSmall = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.SemiBold,
        fontSize = 21.sp,
        lineHeight = 28.sp,
    ),
    titleLarge = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.SemiBold,
        fontSize = 19.sp,
        lineHeight = 26.sp,
    ),
    titleMedium = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.SemiBold,
        fontSize = 16.sp,
        lineHeight = 23.sp,
    ),
    bodyLarge = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.Normal,
        fontSize = 16.sp,
        lineHeight = 24.sp,
    ),
    bodyMedium = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.Normal,
        fontSize = 14.sp,
        lineHeight = 21.sp,
    ),
    labelLarge = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.SemiBold,
        fontSize = 15.sp,
        lineHeight = 20.sp,
    ),
)

private val QaShapes = Shapes(
    extraSmall = RoundedCornerShape(8.dp),
    small = RoundedCornerShape(12.dp),
    medium = RoundedCornerShape(18.dp),
    large = RoundedCornerShape(24.dp),
    extraLarge = RoundedCornerShape(30.dp),
)

@Composable
fun QaHubTheme(
    darkTheme: Boolean = false,
    content: @Composable () -> Unit,
) {
    MaterialTheme(
        colorScheme = if (darkTheme) DarkColors else LightColors,
        typography = QaTypography,
        shapes = QaShapes,
        content = content,
    )
}
