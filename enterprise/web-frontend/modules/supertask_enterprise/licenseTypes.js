import EnterpriseFeaturesObject from '@supertask_enterprise/features'
import PremiumFeaturesObject from '@supertask_premium/features'
import { LicenseType } from '@supertask_premium/licenseTypes'

const commonAdvancedFeatures = [
  // core
  PremiumFeaturesObject.PREMIUM,
  EnterpriseFeaturesObject.RBAC,
  EnterpriseFeaturesObject.TEAMS,
  EnterpriseFeaturesObject.AUDIT_LOG,
  // database
  EnterpriseFeaturesObject.DATA_SYNC,
  EnterpriseFeaturesObject.ADVANCED_WEBHOOKS,
  EnterpriseFeaturesObject.FIELD_LEVEL_PERMISSIONS,
  EnterpriseFeaturesObject.DATE_DEPENDENCY,
  // application builder
  EnterpriseFeaturesObject.BUILDER_SSO,
  EnterpriseFeaturesObject.BUILDER_NO_BRANDING,
  EnterpriseFeaturesObject.BUILDER_FILE_INPUT,
  EnterpriseFeaturesObject.BUILDER_CUSTOM_CODE,
  // Only self-hosted
  EnterpriseFeaturesObject.SSO,
]

export class AdvancedLicenseType extends LicenseType {
  static getType() {
    return 'advanced'
  }

  getName() {
    const { $i18n } = this.app
    return $i18n.t('advanced.license')
  }

  getLicenseBadgeColor() {
    return 'magenta'
  }

  getFeaturesDescription() {
    const { $i18n } = this.app
    return [
      {
        name: $i18n.t('license.premiumFeatureName'),
        enabled: true,
      },
      {
        name: $i18n.t('license.advancedFeatureName'),
        enabled: true,
      },
      {
        name: $i18n.t('license.enterpriseFeatureName'),
        enabled: false,
      },
    ]
  }

  getFeatures() {
    return [...commonAdvancedFeatures]
  }

  getTopSidebarTooltip() {
    const { $i18n } = this.app
    return $i18n.t('enterprise.sidebarTooltip')
  }

  showInTopSidebarWhenActive() {
    return true
  }

  getOrder() {
    return 75
  }

  getSeatsManuallyAssigned() {
    return false
  }

  getLicenseDescription(license) {
    const { $i18n } = this.app
    return $i18n.t('enterprise.licenseDescription')
  }

  getLicenseSeatOverflowWarning(license) {
    const { $i18n } = this.app
    return $i18n.t('enterprise.overflowWarning')
  }
}

export class EnterpriseLicenseType extends AdvancedLicenseType {
  static getType() {
    return 'enterprise'
  }

  getName() {
    const { $i18n } = this.app
    return $i18n.t('enterprise.license')
  }

  getFeatures() {
    return [
      ...commonAdvancedFeatures,
      EnterpriseFeaturesObject.ENTERPRISE_SETTINGS,
    ]
  }

  getFeaturesDescription() {
    const description = super.getFeaturesDescription()
    description[2].enabled = true
    return description
  }

  getOrder() {
    return 101
  }

  getLicenseBadgeColor() {
    return 'neutral'
  }
}
