import java.net.URI

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.ksp)
}

fun String.asBuildConfigString(): String =
    "\"${replace("\\", "\\\\").replace("\"", "\\\"")}\""

val qaHubApiBaseUrl = providers.gradleProperty("qaHubApiBaseUrl")
    .orElse("")
val qaHubProjectId = providers.gradleProperty("qaHubProjectId").orElse("")
require(qaHubApiBaseUrl.get().isNotBlank()) { "Preview requires explicit -PqaHubApiBaseUrl; production fallback is forbidden" }
require(qaHubProjectId.get().matches(Regex("[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}"))) {
    "Preview requires explicit -PqaHubProjectId UUID"
}
require(URI(qaHubApiBaseUrl.get()).port != 4319) { "Preview cannot use production API port 4319" }
val qaHubGameApkDirectoryUrl = providers.gradleProperty("qaHubGameApkDirectoryUrl")
    .orElse("https://qa-hub.invalid/disabled/")
val qaHubVersionCode = providers.gradleProperty("qaHubVersionCode")
    .orElse("15")
    .map { value ->
        value.toIntOrNull()?.takeIf { it > 0 }
            ?: error("qaHubVersionCode must be a positive integer")
    }
val qaHubVersionName = providers.gradleProperty("qaHubVersionName")
    .orElse("0.1.14-debug")
val qaHubPocoPort = providers.gradleProperty("qaHubPocoPort")
    .orElse("5001")
    .map { value ->
        value.toIntOrNull()?.takeIf { it in 1..65_535 }
            ?: error("qaHubPocoPort must be an integer from 1 through 65535")
    }

android {
    namespace = "com.relayqahub.android"
    compileSdk = 37
    buildToolsVersion = "36.0.0"

    defaultConfig {
        applicationId = "com.relayqahub.android.preview"
        minSdk = 29
        targetSdk = 37
        versionCode = qaHubVersionCode.get()
        versionName = qaHubVersionName.get()

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        testInstrumentationRunnerArguments["clearPackageData"] = "true"

        buildConfigField(
            "String",
            "QA_HUB_API_BASE_URL",
            qaHubApiBaseUrl.get().asBuildConfigString(),
        )
        buildConfigField("String", "QA_HUB_CONTRACT_VERSION", "\"1.1.0\"")
        buildConfigField("String", "QA_HUB_PROJECT_ID", qaHubProjectId.get().asBuildConfigString())
        buildConfigField("String", "QA_HUB_UPDATE_CHANNEL", "\"preview\"")
        buildConfigField(
            "String",
            "QA_HUB_GAME_APK_DIRECTORY_URL",
            qaHubGameApkDirectoryUrl.get().asBuildConfigString(),
        )
        buildConfigField("int", "QA_HUB_POCO_PORT", qaHubPocoPort.get().toString())
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
            isDebuggable = true
        }
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }

    buildFeatures {
        buildConfig = true
        compose = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }

    testOptions {
        animationsDisabled = true
        unitTests.isIncludeAndroidResources = true
    }

    sourceSets {
        getByName("androidTest").assets.srcDir(file("schemas"))
    }

    lint {
        abortOnError = true
        checkDependencies = true
        warningsAsErrors = false
    }
}

ksp {
    arg("room.generateKotlin", "true")
    arg("room.incremental", "true")
    arg("room.schemaLocation", file("schemas").absolutePath)
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)

    val composeBom = platform(libs.androidx.compose.bom)
    implementation(composeBom)
    androidTestImplementation(composeBom)
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.ui.tooling.preview)
    debugImplementation(libs.androidx.compose.ui.tooling)

    implementation(libs.androidx.room.runtime)
    implementation(libs.androidx.room.ktx)
    ksp(libs.androidx.room.compiler)

    implementation(libs.androidx.work.runtime.ktx)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.kotlinx.serialization.core)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.okhttp)
    implementation("com.google.zxing:core:3.5.3")

    testImplementation(libs.junit)
    testImplementation("org.json:json:20240303")

    androidTestImplementation(libs.androidx.test.ext.junit)
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.androidx.room.testing)
    androidTestImplementation(libs.androidx.work.testing)
    androidTestImplementation(libs.androidx.compose.ui.test.junit4)
    debugImplementation(libs.androidx.compose.ui.test.manifest)
}
