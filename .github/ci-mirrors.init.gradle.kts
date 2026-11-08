// CI only: fetch Maven Central artifacts from Google's mirror first, so builds don't
// depend on GitHub-hosted downloads (which have been timing out with 504s).
val centralMirror = "https://maven-central.storage-download.googleapis.com/maven2/"

settingsEvaluated {
    pluginManagement.repositories.maven { url = uri(centralMirror) }
    dependencyResolutionManagement.repositories.maven { url = uri(centralMirror) }
}
