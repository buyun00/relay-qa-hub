plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.ksp)
}

fun String.asBuildConfigString(): String =
    "\"${replace("\\", "\\\\").replace("\"", "\\\"")}\""

val qaHubApiBaseUrl = providers.gradleProperty("qaHubApiBaseUrl")
    .orElse("http://10.100.5.157:4319/api/v1/")
val qaHubGameApkDirectoryUrl = providers.gradleProperty("qaHubGameApkDirectoryUrl")
    .orElse("http://10.100.5.129:8000/apk/")
val qaHubVersionCode = providers.gradleProperty("qaHubVersionCode")
    .orElse("13")
    .map { value ->
        value.toIntOrNull()?.takeIf { it > 0 }
            ?: error("qaHubVersionCode must be a positive integer")
    }
val qaHubVersionName = providers.gradleProperty("qaHubVersionName")
    .orElse("0.1.12-debug")
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
        applicationId = "com.relayqahub.android"
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

    testImplementation(libs.junit)

    androidTestImplementation(libs.androidx.test.ext.junit)
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.androidx.room.testing)
    androidTestImplementation(libs.androidx.work.testing)
    androidTestImplementation(libs.androidx.compose.ui.test.junit4)
    debugImplementation(libs.androidx.compose.ui.test.manifest)
}
