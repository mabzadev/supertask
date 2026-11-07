import { SupertaskPlugin } from '@supertask/modules/core/plugins'
import AuditLogSidebarWorkspace from '@supertask_enterprise/components/AuditLogSidebarWorkspace'
import MemberRolesDatabaseContextItem from '@supertask_enterprise/components/member-roles/MemberRolesDatabaseContextItem'
import MemberRolesTableContextItem from '@supertask_enterprise/components/member-roles/MemberRolesTableContextItem'
import MemberRolesViewContextItem from '@supertask_enterprise/components/member-roles/MemberRolesViewContextItem'
import EnterpriseFeatures from '@supertask_enterprise/features'
import SnapshotModalWarning from '@supertask_enterprise/components/SnapshotModalWarning'
import EnterpriseSettings from '@supertask_enterprise/components/EnterpriseSettings'
import EnterpriseSettingsOverrideDashboardHelp from '@supertask_enterprise/components/EnterpriseSettingsOverrideDashboardHelp'
import EnterpriseLogo from '@supertask_enterprise/components/EnterpriseLogo'
import { DatabaseApplicationType } from '@supertask/modules/database/applicationTypes'
import AssistantSidebarItem from '@supertask_enterprise/components/assistant/AssistantSidebarItem'
import AssistantPanel from '@supertask_enterprise/components/assistant/AssistantPanel'
import DateDependencyMenuItem from '@supertask_enterprise/components/dateDependency/DateDependencyMenuItem'
import DateDependencyFieldTypeIcon from '@supertask_enterprise/components/dateDependency/DateDependencyFieldTypeIcon'
import ExportWorkspaceModalWarning from '@supertask_enterprise/components/ExportWorkspaceModalWarning'
import { RestrictedViewOwnershipType } from '@supertask_enterprise/viewOwnershipTypes'

export class EnterprisePlugin extends SupertaskPlugin {
  static getType() {
    return 'enterprise'
  }

  getSidebarWorkspaceComponents(workspace) {
    const sidebarItems = []
    sidebarItems.push(AssistantSidebarItem)
    sidebarItems.push(AuditLogSidebarWorkspace)
    return sidebarItems
  }

  getAdditionalApplicationContextComponents(workspace, application) {
    const additionalComponents = []
    const hasReadRolePermission = this.app.$hasPermission(
      'application.read_role',
      application,
      workspace.id
    )
    if (
      hasReadRolePermission &&
      application.type === DatabaseApplicationType.getType()
    ) {
      additionalComponents.push(MemberRolesDatabaseContextItem)
    }
    return additionalComponents
  }

  getRightSidebarWorkspaceComponents(workspace) {
    const rightSidebarItems = []
    rightSidebarItems.push(AssistantPanel)
    return rightSidebarItems
  }

  getAdditionalTableContextComponents(workspace, table) {
    const out = []
    if (
      this.app.$hasPermission('database.table.read_role', table, workspace.id)
    ) {
      out.push(MemberRolesTableContextItem)
    }
    out.push(DateDependencyMenuItem)
    return out
  }

  getGridViewFieldTypeIconsBefore(workspace, view, field) {
    const out = []
    out.push(DateDependencyFieldTypeIcon)
    return out
  }

  getAdditionalViewContextComponents(workspace, table, view) {
    const components = []
    if (
      this.app.$hasPermission(
        'database.table.view.read_role',
        view,
        workspace.id
      ) &&
      // Assigning a role to a user on view level only actually does something for
      // the restricted view. So we're only showing the modal there.
      view.ownership_type === RestrictedViewOwnershipType.getType()
    ) {
      components.push(MemberRolesViewContextItem)
    }
    components.push(DateDependencyMenuItem)
    return components
  }

  getExtraSnapshotModalComponents(workspace) {
    const rbacSupport = this.app.$hasFeature(
      EnterpriseFeatures.RBAC,
      workspace.id
    )
    return rbacSupport ? SnapshotModalWarning : null
  }

  getExtraExportWorkspaceModalComponents(workspace) {
    const rbacSupport = this.app.$hasFeature(
      EnterpriseFeatures.RBAC,
      workspace.id
    )
    return rbacSupport ? ExportWorkspaceModalWarning : null
  }

  getSettingsPageComponents() {
    return [EnterpriseSettings]
  }

  getDashboardHelpComponents() {
    if (this.app.$hasFeature(EnterpriseFeatures.ENTERPRISE_SETTINGS)) {
      return [EnterpriseSettingsOverrideDashboardHelp]
    } else {
      return []
    }
  }

  getLogoComponent() {
    if (this.app.$hasFeature(EnterpriseFeatures.ENTERPRISE_SETTINGS)) {
      return EnterpriseLogo
    } else {
      return null
    }
  }

  getLogoComponentOrder() {
    return 100
  }

  /**
   * This method can be used to hide certain features in `EnterpriseFeatures.vue`.
   * If the array contains `[EnterpriseFeatures.RBAC]`, for example, then that entry
   * will be hidden in the features.
   */
  getVisuallyHiddenFeatures() {
    return []
  }

  /**
   * Adds the custom CSS/JS defined for this builder.
   */
  getBuilderApplicationHeaderAddition({ builder, mode }) {
    const css = `${this.app.$config.public.publicBackendUrl}/api/custom_code/${
      builder.id
    }/css/${mode === 'preview' ? '' : 'public/'}`
    const js = `${this.app.$config.public.publicBackendUrl}/api/custom_code/${
      builder.id
    }/js/${mode === 'preview' ? '' : 'public/'}`

    const script = []
    const link = []

    builder.scripts.forEach((s) => {
      if (!s.url) {
        return
      }

      const crossorigin =
        s.crossorigin === 'credentials'
          ? 'use-credentials'
          : s.crossorigin === 'anonymous'
            ? 'anonymous'
            : null

      if (s.type === 'javascript') {
        script.push({
          src: s.url,
          crossorigin,
          defer: s.load_type === 'defer',
          async: s.load_type === 'async',
          body: true,
        })
      }

      if (s.type === 'stylesheet') {
        script.push({
          rel: 'stylesheet',
          href: s.url,
          crossorigin,
          body: true,
        })
      }
    })

    if (builder.custom_code.css) {
      link.push({
        rel: 'stylesheet',
        href: css,
        body: true,
      })
    }
    if (builder.custom_code.js) {
      script.push({
        src: js,
        defer: true,
        body: true,
      })
    }

    return {
      link,
      script,
    }
  }
}
