import { AdminType } from '@supertask/modules/core/adminTypes'
import EnterpriseFeatures from '@supertask_enterprise/features'
import PaidFeaturesModal from '@supertask_premium/components/PaidFeaturesModal'
import {
  AuditLogPaidFeature,
  SSOPaidFeature,
} from '@supertask_enterprise/paidFeatures'

class EnterpriseAdminType extends AdminType {
  getDeactivatedModal() {
    return [PaidFeaturesModal, {}]
  }
}

export class AuthProvidersType extends EnterpriseAdminType {
  static getType() {
    return 'auth-providers'
  }

  getIconClass() {
    return 'iconoir-log-in'
  }

  getName() {
    const { $i18n } = this.app
    return $i18n.t('adminType.Authentication')
  }

  getRouteName() {
    return 'admin-auth-providers'
  }

  getOrder() {
    return 100
  }

  isDeactivated() {
    return !this.app.$hasFeature(EnterpriseFeatures.SSO)
  }

  getDeactivatedModal() {
    return [
      PaidFeaturesModal,
      { 'initial-selected-type': SSOPaidFeature.getType() },
    ]
  }
}

export class AuditLogType extends EnterpriseAdminType {
  static getType() {
    return 'audit-log'
  }

  getIconClass() {
    return 'supertask-icon-history'
  }

  getName() {
    const { $i18n } = this.app
    return $i18n.t('adminType.AuditLog')
  }

  getRouteName() {
    return 'admin-audit-log'
  }

  getOrder() {
    return 110
  }

  isDeactivated() {
    return !this.app.$hasFeature(EnterpriseFeatures.AUDIT_LOG)
  }

  getDeactivatedModal() {
    return [
      PaidFeaturesModal,
      { 'initial-selected-type': AuditLogPaidFeature.getType() },
    ]
  }
}
