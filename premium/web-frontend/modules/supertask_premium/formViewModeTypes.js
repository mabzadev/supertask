import { FormViewModeType } from '@supertask/modules/database/formViewModeTypes'
import FormViewModeSurvey from '@supertask_premium/components/views/form/FormViewModeSurvey'
import FormViewModePreviewSurvey from '@supertask_premium/components/views/form/FormViewModePreviewSurvey'
import PremiumFeatures from '@supertask_premium/features'
import PaidFeaturesModal from '@supertask_premium/components/PaidFeaturesModal'
import { FormSurveyModePaidFeature } from '@supertask_premium/paidFeatures'

export class FormViewSurveyModeType extends FormViewModeType {
  static getType() {
    return 'survey'
  }

  getName() {
    const { $i18n } = this.app
    return $i18n.t('formViewModeType.survey')
  }

  getDescription() {
    const { $i18n } = this.app
    return $i18n.t('formViewModeType.surveyDescription')
  }

  getIconClass() {
    return 'iconoir-reports'
  }

  getDeactivatedText() {
    const { $i18n } = this.app
    return $i18n.t('formViewModeType.onlyForPremium')
  }

  getDeactivatedClickModal() {
    return [
      PaidFeaturesModal,
      { 'initial-selected-type': FormSurveyModePaidFeature.getType() },
    ]
  }

  isDeactivated(workspaceId) {
    return !this.app.$hasFeature(PremiumFeatures.PREMIUM, workspaceId)
  }

  getFormComponent() {
    return FormViewModeSurvey
  }

  getPreviewComponent() {
    return FormViewModePreviewSurvey
  }
}
