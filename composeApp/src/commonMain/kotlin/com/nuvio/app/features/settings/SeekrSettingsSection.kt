package com.nuvio.app.features.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.nuvio.app.core.network.SupabaseConfig
import com.nuvio.app.features.player.PlayerSettingsStorage

/**
 * Seek preview thumbnails powered by Seekr (https://seekr.tv). Paste a free API key to show
 * a thumbnail above the seek bar while scrubbing. Leave blank to turn the feature off.
 * The key is stored on this device only and is not synced.
 */
@Composable
internal fun SeekrSettingsSection(isTablet: Boolean) {
    var apiKey by remember { mutableStateOf(PlayerSettingsStorage.loadSeekrApiKey().orEmpty()) }
    var localFallback by remember { mutableStateOf(PlayerSettingsStorage.loadLocalSeekPreviewEnabled()) }
    var wifiOnly by remember { mutableStateOf(PlayerSettingsStorage.loadLocalSeekPreviewWifiOnly()) }

    SettingsSection(
        title = "Seek preview thumbnails",
        isTablet = isTablet,
    ) {
        SettingsGroup(isTablet = isTablet) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(
                    text = "Shows a thumbnail above the seek bar while you scrub, using Seekr. " +
                        "Paste your API key from seekr.tv, or leave it empty to use only on-device previews. " +
                        "Takes effect the next time you open the player.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                val syncHost = SupabaseConfig.URL.substringAfter("://").substringBefore('/')
                Text(
                    text = "Build: seekr-4 (local fallback + status) · Sync server: " + syncHost.ifBlank { "NOT CONFIGURED" },
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                SettingsSecretTextField(
                    value = apiKey,
                    onValueChange = {
                        apiKey = it
                        PlayerSettingsStorage.saveSeekrApiKey(it)
                    },
                    label = "Seekr API key",
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            SettingsGroupDivider(isTablet = isTablet)
            SettingsSwitchRow(
                title = "Generate previews on this device",
                description = "When Seekr has no previews for a title (e.g. Malayalam and other regional films), " +
                    "build them from the stream itself. Works with direct links, not HLS or torrents.",
                checked = localFallback,
                isTablet = isTablet,
                onCheckedChange = {
                    localFallback = it
                    PlayerSettingsStorage.saveLocalSeekPreviewEnabled(it)
                },
            )
            SettingsGroupDivider(isTablet = isTablet)
            SettingsSwitchRow(
                title = "Pre-generate on Wi-Fi only",
                description = "Previews near where you scrub are always generated. The background pass " +
                    "(about one frame per minute) only runs on Wi-Fi to save mobile data.",
                checked = wifiOnly,
                enabled = localFallback,
                isTablet = isTablet,
                onCheckedChange = {
                    wifiOnly = it
                    PlayerSettingsStorage.saveLocalSeekPreviewWifiOnly(it)
                },
            )
        }
    }
}
