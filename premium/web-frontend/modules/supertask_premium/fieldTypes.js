import {
  FieldType,
  FormulaFieldType,
} from '@supertask/modules/database/fieldTypes'

import GridViewFieldAI from '@supertask_premium/components/views/grid/fields/GridViewFieldAI'
import FunctionalGridViewFieldAI from '@supertask_premium/components/views/grid/fields/FunctionalGridViewFieldAI'
import RowEditFieldAI from '@supertask_premium/components/row/RowEditFieldAI'
import FieldAISubForm from '@supertask_premium/components/field/FieldAISubForm'
import FormulaFieldAI from '@supertask_premium/components/field/FormulaFieldAI'
import GridViewFieldAIGenerateValuesContextItem from '@supertask_premium/components/views/grid/fields/GridViewFieldAIGenerateValuesContextItem'
import PremiumFeatures from '@supertask_premium/features'
import PaidFeaturesModal from '@supertask_premium/components/PaidFeaturesModal'
import { AIPaidFeature } from '@supertask_premium/paidFeatures'
import _ from 'lodash'
import WorkspaceSettingsModal from '@supertask/modules/core/components/workspace/WorkspaceSettingsModal.vue'

export class AIFieldType extends FieldType {
  static getType() {
    return 'ai'
  }

  getIconClass() {
    return 'iconoir-magic-wand'
  }

  getName() {
    const { $i18n } = this.app
    return $i18n.t('premiumFieldType.ai')
  }

  isReadOnlyField(field) {
    if (field && _.isBoolean(field.read_only)) {
      return field.read_only
    }
    return false
  }

  getGridViewFieldComponent() {
    return GridViewFieldAI
  }

  getFunctionalGridViewFieldComponent() {
    return FunctionalGridViewFieldAI
  }

  getRowEditFieldComponent(field) {
    return RowEditFieldAI
  }

  getFormComponent() {
    return FieldAISubForm
  }

  getSupertaskFieldType(field) {
    return this.app.$registry
      .get('aiFieldOutputType', field.ai_output_type)
      .getSupertaskFieldType()
  }

  getCardComponent(field) {
    return this.getSupertaskFieldType(field).getCardComponent(field)
  }

  getRowHistoryEntryComponent(field) {
    return null
  }

  getFormViewFieldComponents(field) {
    return {}
  }

  getDefaultValue(field) {
    return null
  }

  getCardValueHeight(field) {
    return this.getSupertaskFieldType(field).getCardValueHeight(field)
  }

  getSort(name, order, field) {
    return this.getSupertaskFieldType(field).getSort(name, order, field)
  }

  getCanSortInView(field) {
    return this.getSupertaskFieldType(field).getCanSortInView(field)
  }

  getDocsDataType(field) {
    return this.getSupertaskFieldType(field).getDocsDataType(field)
  }

  getDocsDescription(field) {
    const { $i18n } = this.app
    return $i18n.t('premiumFieldType.aiDescription')
  }

  getDocsRequestExample(field) {
    return 'read only'
  }

  getDocsResponseExample(field) {
    return this.getSupertaskFieldType(field).getDocsResponseExample(field)
  }

  prepareValueForCopy(field, value) {
    return this.getSupertaskFieldType(field).prepareValueForCopy(field, value)
  }

  getContainsFilterFunction(field) {
    return this.getSupertaskFieldType(field).getContainsFilterFunction(field)
  }

  getContainsWordFilterFunction(field) {
    return this.getSupertaskFieldType(field).getContainsWordFilterFunction(field)
  }

  toHumanReadableString(field, value) {
    return this.getSupertaskFieldType(field).toHumanReadableString(field, value)
  }

  getSortIndicator(field) {
    return this.getSupertaskFieldType(field).getSortIndicator(field)
  }

  canRepresentDate(field) {
    return this.getSupertaskFieldType(field).canRepresentDate(field)
  }

  getCanGroupByInView(field) {
    return this.getSupertaskFieldType(field).getCanGroupByInView(field)
  }

  parseInputValue(field, value) {
    return this.getSupertaskFieldType(field).parseInputValue(field, value)
  }

  canRepresentFiles(field) {
    return this.getSupertaskFieldType(field).canRepresentFiles(field)
  }

  getHasEmptyValueFilterFunction(field) {
    return this.getSupertaskFieldType(field).getHasEmptyValueFilterFunction(field)
  }

  getHasValueContainsFilterFunction(field) {
    return this.getSupertaskFieldType(field).getHasValueContainsFilterFunction(
      field
    )
  }

  getHasValueContainsWordFilterFunction(field) {
    return this.getSupertaskFieldType(
      field
    ).getHasValueContainsWordFilterFunction(field)
  }

  getHasValueLengthIsLowerThanFilterFunction(field) {
    return this.getSupertaskFieldType(
      field
    ).getHasValueLengthIsLowerThanFilterFunction(field)
  }

  getGroupByComponent(field) {
    return this.getSupertaskFieldType(field).getGroupByComponent(field)
  }

  getRowValueFromGroupValue(field, value) {
    return this.getSupertaskFieldType(field).getRowValueFromGroupValue(
      field,
      value
    )
  }

  getGroupValueFromRowValue(field, value) {
    return this.getSupertaskFieldType(field).getGroupValueFromRowValue(
      field,
      value
    )
  }

  isEqual(field, value1, value2) {
    return this.getSupertaskFieldType(field).isEqual(field, value1, value2)
  }

  parseFilterValue(field, filterValue) {
    return this.getSupertaskFieldType(field).parseFilterValue(field, filterValue)
  }

  formatFilterValue(field, value) {
    return this.getSupertaskFieldType(field).formatFilterValue(field, value)
  }

  canBeReferencedByFormulaField(field) {
    return this.getSupertaskFieldType(field).canBeReferencedByFormulaField(field)
  }

  getGridViewContextItemsOnCellsSelection(field) {
    return [GridViewFieldAIGenerateValuesContextItem]
  }

  isEnabled(workspace) {
    return Object.values(workspace?.generative_ai_models_enabled || {}).some(
      (models) => models.length > 0
    )
  }

  getDisabledClickModal(workspace) {
    return [WorkspaceSettingsModal, { workspace }]
  }

  getDisabledTooltip() {
    return 'Click to configure API key'
  }

  isDeactivated(workspaceId) {
    return !this.app.$hasFeature(PremiumFeatures.PREMIUM, workspaceId)
  }

  getDeactivatedClickModal(workspaceId) {
    return [
      PaidFeaturesModal,
      { 'initial-selected-type': AIPaidFeature.getType() },
    ]
  }

  prepareValueForUpdate(field, value) {
    return this.getSupertaskFieldType(field).prepareValueForUpdate(field, value)
  }

  prepareValueForPaste(field, value) {
    return this.getSupertaskFieldType(field).prepareValueForPaste(field, value)
  }

  getCompatibleFilterFieldType(field) {
    return this.getSupertaskFieldType(field)
  }
}

export class PremiumFormulaFieldType extends FormulaFieldType {
  getAdditionalFormInputComponents() {
    return [FormulaFieldAI]
  }
}
