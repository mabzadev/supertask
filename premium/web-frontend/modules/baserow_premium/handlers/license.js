export class LicenseHandler {
  constructor(app) {
    this.getters = app.$store.getters
    this.dispatch = app.$store.dispatch
    this.$registry = app.$registry
    this.app = app
  }

  listenToBusEvents() {
    return this.app.$bus.$on(
      'user-data-updated',
      this.afterUserDataUpdate.bind(this)
    )
  }

  /**
   * Triggers updates to any frontend stores that might need updating if a license
   * has changed.
   */
  async afterUserDataUpdate(updatedUserData) {
    if (updatedUserData?.active_licenses?.instance_wide) {
      // There has been some update to an instance wide license, force all workspaces
      // to refresh their roles
      for (const workspace of this.getters['workspace/getAll']) {
        await this.dispatch('workspace/forceRefreshRoles', workspace)
      }
    } else {
      // Otherwise only update the workspaces for whom their active licenses have
      // changed.
      for (const workspaceId of Object.keys(
        updatedUserData?.active_licenses?.per_workspace || {}
      )) {
        const workspace = this.getters['workspace/get'](parseInt(workspaceId))
        if (workspace) {
          await this.dispatch('workspace/forceRefreshRoles', workspace)
        }
      }
    }
  }

  /**
   * Returns a list of all active licenses the current user has instance wide.
   */
  instanceWideLicenseTypes() {
    return ['enterprise', 'enterprise_without_support', 'advanced', 'premium']
      .filter((key) => this.$registry.exists('license', key))
      .map((key) => this.$registry.get('license', key))
  }

  /**
   * Returns the highest instance wide license type a user has or null if they have
   * none. The highest instance wide license is the one whose LicenseType.getOrder()
   * is the highest.
   */
  highestInstanceWideLicenseType() {
    const orderedLicenses = this.instanceWideLicenseTypes().sort(
      (a, b) => b.getOrder() - a.getOrder()
    )
    if (orderedLicenses.length === 0) {
      return null
    } else {
      return orderedLicenses[0]
    }
  }

  /**
   * Returns any licenses the current user might have active for the specific workspace.
   */
  getWorkspaceLicenseTypes(workspaceId) {
    return this.instanceWideLicenseTypes()
  }

  userHasFeatureEnabledInstanceWide(feature) {
    return this.instanceWideLicenseTypes().some((t) =>
      t.getFeatures().includes(feature)
    )
  }

  userHasFeatureEnabledForWorkspaceOnly(feature, workspaceId) {
    return this.getWorkspaceLicenseTypes(workspaceId).some((t) =>
      t.getFeatures().includes(feature)
    )
  }

  hasFeature(feature, forSpecificWorkspace = null) {
    return true
  }
}
