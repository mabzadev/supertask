import { SupertaskPlugin } from '@supertask/modules/core/plugins'
import Impersonate from '@supertask_premium/components/sidebar/Impersonate'
import HighestLicenseTypeBadge from '@supertask_premium/components/sidebar/HighestLicenseTypeBadge'
import PremiumViewOptions from '@supertask_premium/components/views/PremiumViewOptions'
import PublicViewExport from '@supertask_premium/components/views/PublicViewExport'

export class PremiumPlugin extends SupertaskPlugin {
  static getType() {
    return 'premium'
  }

  getImpersonateComponent() {
    return Impersonate
  }

  getHighestLicenseTypeBadge() {
    return HighestLicenseTypeBadge
  }

  getAdditionalShareLinkOptions() {
    return [PremiumViewOptions]
  }

  getAdditionalTableHeaderComponents(view, isPublic) {
    return isPublic ? [PublicViewExport] : []
  }

  hasFeature(feature, forSpecificWorkspace) {
    return this.app.$licenseHandler.hasFeature(feature, forSpecificWorkspace)
  }

  /**
   * A hook to provide different action buttons to the premium features modal.
   */
  getPremiumModalButtonsComponent() {
    return null
  }
}
