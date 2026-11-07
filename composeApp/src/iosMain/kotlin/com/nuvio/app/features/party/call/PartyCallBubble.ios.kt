package com.nuvio.app.features.party.call

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import com.nuvio.app.features.party.ActiveParty

@Composable
actual fun PartyCallBubble(
    party: ActiveParty?,
    visible: Boolean,
    modifier: Modifier,
) {
    // Video calls are Android-only for now.
}
