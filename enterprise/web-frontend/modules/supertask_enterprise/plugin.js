import { AuditLogExportJobType } from '@supertask_enterprise/jobTypes'
import { registerRealtimeEvents } from '@supertask_enterprise/realtime'
import {
  RolePermissionManagerType,
  WriteFieldValuesPermissionManagerType,
} from '@supertask_enterprise/permissionManagerTypes'
import { AuditLogType, AuthProvidersType } from '@supertask_enterprise/adminTypes'
import authProviderAdminStore from '@supertask_enterprise/store/authProviderAdmin'
import assistantStore from '@supertask_enterprise/store/assistant'
import { PasswordAuthProviderType as CorePasswordAuthProviderType } from '@supertask/modules/core/authProviderTypes'
import { MadeWithSupertaskBuilderPageDecoratorType } from '@supertask_enterprise/builderPageDecoratorTypes'
import {
  FacebookAuthProviderType,
  GitHubAuthProviderType,
  GitLabAuthProviderType,
  GoogleAuthProviderType,
  OpenIdConnectAuthProviderType,
  PasswordAuthProviderType,
  SamlAuthProviderType,
} from '@supertask_enterprise/authProviderTypes'
import { TeamsWorkspaceSettingsPageType } from '@supertask_enterprise/workspaceSettingsPageTypes'
import { EnterpriseMembersPagePluginType } from '@supertask_enterprise/membersPagePluginTypes'
import {
  AdvancedLicenseType,
  EnterpriseLicenseType,
} from '@supertask_enterprise/licenseTypes'
import { EnterprisePlugin } from '@supertask_enterprise/plugins'
import { LocalSupertaskUserSourceType } from '@supertask_enterprise/integrations/userSourceTypes'
import {
  LocalSupertaskPasswordAppAuthProviderType,
  OpenIdConnectAppAuthProviderType,
  SamlAppAuthProviderType,
} from '@supertask_enterprise/integrations/appAuthProviderTypes'
import {
  AuthFormElementType,
  FileInputElementType,
} from '@supertask_enterprise/builder/elementTypes'
import {
  EnterpriseAdminRoleType,
  EnterpriseBuilderRoleType,
  EnterpriseCommenterRoleType,
  EnterpriseEditorRoleType,
  EnterpriseMemberRoleType,
  EnterpriseViewerRoleType,
  NoAccessRoleType,
  NoRoleLowPriorityRoleType,
} from '@supertask_enterprise/roleTypes'
import {
  GitHubIssuesDataSyncType,
  PostgreSQLDataSyncType,
  LocalSupertaskTableDataSyncType,
} from '@supertask_enterprise/dataSyncTypes'
import { PeriodicIntervalFieldsConfigureDataSyncType } from '@supertask_enterprise/configureDataSyncTypes'
import {
  PeriodicDataSyncDeactivatedNotificationType,
  TwoWayDataSyncUpdateFiledNotificationType,
  TwoWaySyncDeactivatedNotificationType,
} from '@supertask_enterprise/notificationTypes'
import { RowsEnterViewWebhookEventType } from '@supertask_enterprise/webhookEventTypes'
import {
  AdvancedWebhooksPaidFeature,
  AuditLogPaidFeature,
  BuilderBrandingPaidFeature,
  BuilderCustomCodePaidFeature,
  BuilderFileInputElementPaidFeature,
  CoBrandingPaidFeature,
  DataSyncPaidFeature,
  DateDependencyPaidFeature,
  FieldLevelPermissionsPaidFeature,
  RBACPaidFeature,
  SSOPaidFeature,
} from '@supertask_enterprise/paidFeatures'
import { FieldPermissionsContextItemType } from '@supertask_enterprise/fieldContextItemTypes'
import {
  DateDependencyContextItemType,
  DateDependencyTimelineComponent,
} from '@supertask_enterprise/dateDependencyTypes'
import { CustomCodeBuilderSettingType } from '@supertask_enterprise/builderSettingTypes'
import { RealtimePushTwoWaySyncStrategyType } from '@supertask_enterprise/twoWaySyncStrategyTypes'
import { RestrictedViewOwnershipType } from '@supertask_enterprise/viewOwnershipTypes'
import { AIDatabaseOnboardingStepType } from '@supertask_enterprise/databaseOnboardingStepTypes'

export default defineNuxtPlugin({
  name: 'enterprise',
  dependsOn: ['premium', 'registry'],
  setup(nuxtApp) {
    const { $registry, $store, $featureFlagIsEnabled } = nuxtApp

    const context = { app: nuxtApp }

    $registry.register('plugin', new EnterprisePlugin(context))

    $registry.register(
      'permissionManager',
      new RolePermissionManagerType(context)
    )
    $registry.register(
      'permissionManager',
      new WriteFieldValuesPermissionManagerType(context)
    )

    $store.registerModuleNuxtSafe('authProviderAdmin', authProviderAdminStore)
    $store.registerModuleNuxtSafe('assistant', assistantStore)

    $registry.register('admin', new AuthProvidersType(context))
    $registry.unregister(
      'authProvider',
      new CorePasswordAuthProviderType(context)
    )
    $registry.register('authProvider', new PasswordAuthProviderType(context))
    $registry.register('authProvider', new SamlAuthProviderType(context))
    $registry.register('authProvider', new GoogleAuthProviderType(context))
    $registry.register('authProvider', new FacebookAuthProviderType(context))
    $registry.register('authProvider', new GitHubAuthProviderType(context))
    $registry.register('authProvider', new GitLabAuthProviderType(context))
    $registry.register(
      'authProvider',
      new OpenIdConnectAuthProviderType(context)
    )

    $registry.register('admin', new AuditLogType(context))
    $registry.register('plugin', new EnterprisePlugin(context))

    $registry.register(
      'membersPagePlugins',
      new EnterpriseMembersPagePluginType(context)
    )

    $registry.register(
      'workspaceSettingsPage',
      new TeamsWorkspaceSettingsPageType(context)
    )

    $registry.register('job', new AuditLogExportJobType(context))

    $registry.register('license', new AdvancedLicenseType(context))
    $registry.register('license', new EnterpriseLicenseType(context))

    $registry.register('userSource', new LocalSupertaskUserSourceType(context))

    $registry.register(
      'appAuthProvider',
      new LocalSupertaskPasswordAppAuthProviderType(context)
    )

    $registry.register('appAuthProvider', new SamlAppAuthProviderType(context))
    $registry.register(
      'appAuthProvider',
      new OpenIdConnectAppAuthProviderType(context)
    )

    $registry.register('roles', new EnterpriseAdminRoleType(context))
    $registry.register('roles', new EnterpriseMemberRoleType(context))
    $registry.register('roles', new EnterpriseBuilderRoleType(context))
    $registry.register('roles', new EnterpriseEditorRoleType(context))
    $registry.register('roles', new EnterpriseCommenterRoleType(context))
    $registry.register('roles', new EnterpriseViewerRoleType(context))
    $registry.register('roles', new NoAccessRoleType(context))
    $registry.register('roles', new NoRoleLowPriorityRoleType(context))

    $registry.register('element', new AuthFormElementType(context))
    $registry.register('element', new FileInputElementType(context))

    $registry.unregister('dataSync', PostgreSQLDataSyncType.getType())
    $registry.register('dataSync', new PostgreSQLDataSyncType(context))
    $registry.register('dataSync', new LocalSupertaskTableDataSyncType(context))
    $registry.register('dataSync', new GitHubIssuesDataSyncType(context))

    $registry.register(
      'notification',
      new PeriodicDataSyncDeactivatedNotificationType(context)
    )
    $registry.register(
      'notification',
      new TwoWayDataSyncUpdateFiledNotificationType(context)
    )
    $registry.register(
      'notification',
      new TwoWaySyncDeactivatedNotificationType(context)
    )

    $registry.register(
      'configureDataSync',
      new PeriodicIntervalFieldsConfigureDataSyncType(context)
    )

    $registry.register(
      'webhookEvent',
      new RowsEnterViewWebhookEventType(context)
    )

    $registry.register('paidFeature', new SSOPaidFeature(context))
    $registry.register('paidFeature', new AuditLogPaidFeature(context))
    $registry.register('paidFeature', new RBACPaidFeature(context))
    $registry.register('paidFeature', new DataSyncPaidFeature(context))
    $registry.register('paidFeature', new CoBrandingPaidFeature(context))
    $registry.register('paidFeature', new AdvancedWebhooksPaidFeature(context))
    $registry.register(
      'paidFeature',
      new FieldLevelPermissionsPaidFeature(context)
    )
    $registry.register('paidFeature', new BuilderBrandingPaidFeature(context))
    $registry.register('paidFeature', new BuilderCustomCodePaidFeature(context))
    $registry.register(
      'paidFeature',
      new BuilderFileInputElementPaidFeature(context)
    )

    $registry.register('paidFeature', new DateDependencyPaidFeature(context))
    $registry.register(
      'timelineFieldRules',
      new DateDependencyTimelineComponent(context)
    )
    $registry.register(
      'fieldContextItem',
      new DateDependencyContextItemType(context)
    )

    // Register builder page decorator namespace and types
    $registry.register(
      'builderPageDecorator',
      new MadeWithSupertaskBuilderPageDecoratorType(context)
    )

    $registry.register(
      'databaseOnboardingStep',
      new AIDatabaseOnboardingStepType(context)
    )

    $registry.register(
      'fieldContextItem',
      new FieldPermissionsContextItemType(context)
    )

    $registry.register(
      'builderSettings',
      new CustomCodeBuilderSettingType(context)
    )

    $registry.register(
      'twoWaySyncStrategy',
      new RealtimePushTwoWaySyncStrategyType(context)
    )

    if ($featureFlagIsEnabled('view_permissions')) {
      $registry.register(
        'viewOwnershipType',
        new RestrictedViewOwnershipType(context)
      )
    }
  },
})
