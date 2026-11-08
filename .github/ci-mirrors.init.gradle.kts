// CI only: point Maven Central at Google's mirror, so builds don't depend on
// GitHub-hosted downloads (Maven Central redirects some JetBrains jars to GitHub
// releases, which have been timing out with 504s).
val centralMirror = "https://maven-central.storage-download.googleapis.com/maven2/"
val centralHosts = setOf("repo.maven.apache.org", "repo1.maven.org")

fun RepositoryHandler.useCentralMirror() {
    all {
        val repo = this
        if (repo is MavenArtifactRepository && repo.url.host in centralHosts) {
            repo.setUrl(centralMirror)
        }
    }
}

settingsEvaluated {
    pluginManagement.repositories.useCentralMirror()
    dependencyResolutionManagement.repositories.useCentralMirror()
}

allprojects {
    buildscript.repositories.useCentralMirror()
    repositories.useCentralMirror()
}
