import { IntegrationType } from '@supertask/modules/core/integrationTypes'
import LocalSupertaskForm from '@supertask/modules/integrations/localSupertask/components/integrations/LocalSupertaskForm'
import localSupertaskIntegration from '@supertask/modules/integrations/localSupertask/assets/images/localSupertaskIntegration.svg?url'

export class LocalSupertaskIntegrationType extends IntegrationType {
  static getType() {
    return 'local_supertask'
  }

  get name() {
    return this.app.$i18n.t('integrationType.localSupertask')
  }

  get image() {
    return localSupertaskIntegration
  }

  getSummary(integration) {
    if (!integration.authorized_user) {
      return this.app.$i18n.t('localSupertaskIntegrationType.localSupertaskNoUser')
    }

    return this.app.$i18n.t('localSupertaskIntegrationType.localSupertaskSummary', {
      name: integration.authorized_user.first_name,
      username: integration.authorized_user.username,
    })
  }

  get formComponent() {
    return LocalSupertaskForm
  }

  get warning() {
    return this.app.$i18n.t('localSupertaskIntegrationType.localSupertaskWarning')
  }

  getDefaultValues() {
    const user = this.app.$store.getters['auth/getUserObject']
    return {
      authorized_user: { username: user.username, first_name: user.first_name },
    }
  }

  getOrder() {
    return 10
  }
}
