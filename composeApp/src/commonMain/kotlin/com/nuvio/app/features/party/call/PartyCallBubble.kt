package com.nuvio.app.features.party.call

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import com.nuvio.app.features.party.ActiveParty

/**
 * Floating video call bubble shown over the player while a watch party is active.
 * Each platform provides its own implementation; platforms without one render nothing.
 *
 * @param party the active watch party, or null when not in a party (the call is left).
 * @param visible false hides the bubble (e.g. in picture-in-picture) without leaving the call.
 * @param controlsVisible whether the player controls are showing; the call button and the
 *   call's buttons fade in and out with them, while camera tiles stay on screen.
 */
@Composable
expect fun PartyCallBubble(
    party: ActiveParty?,
    visible: Boolean,
    controlsVisible: Boolean = true,
    modifier: Modifier = Modifier,
)
