package com.relayqahub.android.overlay

import kotlin.math.pow

/**
 * Platform-independent gesture arbitration for the overlay bubble.
 *
 * A tap is deliberately delayed until the double-tap window expires. Drag and
 * long-press both cancel any pending tap, so one pointer sequence can emit at
 * most one user action.
 */
internal class OverlayGestureStateMachine(
    private val dragSlopPx: Float,
    private val doubleTapSlopPx: Float,
    private val doubleTapTimeoutMs: Long,
    private val longPressTimeoutMs: Long,
) {
    enum class Signal {
        NONE,
        DRAG,
        DRAG_END,
        SINGLE_TAP,
        DOUBLE_TAP,
        LONG_PRESS,
    }

    private data class PointerSample(
        val atMs: Long,
        val x: Float,
        val y: Float,
    )

    private var down: PointerSample? = null
    private var pendingTap: PointerSample? = null
    private var dragging = false
    private var longPressDelivered = false

    fun onDown(
        atMs: Long,
        x: Float,
        y: Float,
    ) {
        down = PointerSample(atMs, x, y)
        dragging = false
        longPressDelivered = false
    }

    fun onMove(
        x: Float,
        y: Float,
    ): Signal {
        val origin = down ?: return Signal.NONE
        if (longPressDelivered) return Signal.NONE

        if (!dragging && origin.distanceSquaredTo(x, y) > dragSlopPx.pow(2)) {
            dragging = true
            pendingTap = null
        }
        return if (dragging) Signal.DRAG else Signal.NONE
    }

    fun onLongPressDeadline(atMs: Long): Signal {
        val origin = down ?: return Signal.NONE
        if (
            dragging ||
            longPressDelivered ||
            atMs - origin.atMs < longPressTimeoutMs
        ) {
            return Signal.NONE
        }

        longPressDelivered = true
        pendingTap = null
        return Signal.LONG_PRESS
    }

    fun onUp(
        atMs: Long,
        x: Float,
        y: Float,
    ): Signal {
        if (down == null) return Signal.NONE
        down = null

        if (dragging) {
            dragging = false
            longPressDelivered = false
            return Signal.DRAG_END
        }
        if (longPressDelivered) {
            longPressDelivered = false
            return Signal.NONE
        }

        val previousTap = pendingTap
        if (
            previousTap != null &&
            atMs - previousTap.atMs <= doubleTapTimeoutMs &&
            previousTap.distanceSquaredTo(x, y) <= doubleTapSlopPx.pow(2)
        ) {
            pendingTap = null
            return Signal.DOUBLE_TAP
        }

        pendingTap = PointerSample(atMs, x, y)
        return Signal.NONE
    }

    fun onSingleTapDeadline(atMs: Long): Signal {
        val tap = pendingTap ?: return Signal.NONE
        // A second pointer is still deciding between double-tap, drag, and
        // long-press. Do not let the first tap fire underneath that gesture.
        if (down != null) return Signal.NONE
        if (atMs - tap.atMs < doubleTapTimeoutMs) return Signal.NONE

        pendingTap = null
        return Signal.SINGLE_TAP
    }

    fun cancelPointer() {
        down = null
        dragging = false
        longPressDelivered = false
    }

    fun cancelAll() {
        cancelPointer()
        pendingTap = null
    }

    private fun PointerSample.distanceSquaredTo(
        otherX: Float,
        otherY: Float,
    ): Float = (x - otherX).pow(2) + (y - otherY).pow(2)
}
