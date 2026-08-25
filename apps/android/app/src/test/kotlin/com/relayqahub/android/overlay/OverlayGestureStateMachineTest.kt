package com.relayqahub.android.overlay

import org.junit.Assert.assertEquals
import org.junit.Test

class OverlayGestureStateMachineTest {
    @Test
    fun `tap waits for double-tap window and second tap suppresses single`() {
        val gestures = gestures()

        gestures.onDown(atMs = 0, x = 10f, y = 10f)
        assertEquals(
            OverlayGestureStateMachine.Signal.NONE,
            gestures.onUp(atMs = 40, x = 10f, y = 10f),
        )
        assertEquals(
            OverlayGestureStateMachine.Signal.NONE,
            gestures.onSingleTapDeadline(atMs = 299),
        )
        gestures.onDown(atMs = 120, x = 12f, y = 11f)
        assertEquals(
            OverlayGestureStateMachine.Signal.NONE,
            gestures.onSingleTapDeadline(atMs = 340),
        )
        assertEquals(
            OverlayGestureStateMachine.Signal.DOUBLE_TAP,
            gestures.onUp(atMs = 340, x = 12f, y = 11f),
        )
        assertEquals(
            OverlayGestureStateMachine.Signal.NONE,
            gestures.onSingleTapDeadline(atMs = 500),
        )
    }

    @Test
    fun `drag and long press are mutually exclusive with tap`() {
        val drag = gestures()
        drag.onDown(atMs = 0, x = 0f, y = 0f)
        assertEquals(
            OverlayGestureStateMachine.Signal.DRAG,
            drag.onMove(x = 20f, y = 0f),
        )
        assertEquals(
            OverlayGestureStateMachine.Signal.NONE,
            drag.onLongPressDeadline(atMs = 600),
        )
        assertEquals(
            OverlayGestureStateMachine.Signal.DRAG_END,
            drag.onUp(atMs = 620, x = 20f, y = 0f),
        )

        val longPress = gestures()
        longPress.onDown(atMs = 0, x = 0f, y = 0f)
        assertEquals(
            OverlayGestureStateMachine.Signal.LONG_PRESS,
            longPress.onLongPressDeadline(atMs = 500),
        )
        assertEquals(
            OverlayGestureStateMachine.Signal.NONE,
            longPress.onUp(atMs = 520, x = 0f, y = 0f),
        )
        assertEquals(
            OverlayGestureStateMachine.Signal.NONE,
            longPress.onSingleTapDeadline(atMs = 900),
        )
    }

    private fun gestures() = OverlayGestureStateMachine(
        dragSlopPx = 8f,
        doubleTapSlopPx = 24f,
        doubleTapTimeoutMs = 300,
        longPressTimeoutMs = 500,
    )
}
