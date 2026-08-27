package com.relayqahub.android.capture

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CaptureDisplayGeometryTest {
    @Test
    fun `switching from portrait app to landscape game reconfigures capture surface`() {
        val portrait = CaptureDisplayGeometry.fromPixels(1080, 2400, 440)
        val landscape = CaptureDisplayGeometry.fromPixels(2400, 1080, 440)

        assertTrue(landscape.width > landscape.height)
        assertTrue(landscape.requiresReconfigure(portrait))
        assertFalse(landscape.requiresReconfigure(landscape.copy()))
        assertTrue(landscape.matchesFrame(2400, 1080))
        assertFalse(landscape.matchesFrame(1080, 2400))
    }
}
