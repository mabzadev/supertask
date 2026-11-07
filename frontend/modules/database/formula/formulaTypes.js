import { Registerable } from '@supertask/modules/core/registry'
import RowEditFieldText from '@supertask/modules/database/components/row/RowEditFieldText'
import RowEditFieldLongText from '@supertask/modules/database/components/row/RowEditFieldLongText'
import RowEditFieldNumber from '@supertask/modules/database/components/row/RowEditFieldNumber'
import RowEditFieldDateReadOnly from '@supertask/modules/database/components/row/RowEditFieldDateReadOnly'
import GridViewFieldLongText from '@supertask/modules/database/components/view/grid/fields/GridViewFieldLongText'
import RowEditFieldBoolean from '@supertask/modules/database/components/row/RowEditFieldBoolean'
import FunctionalGridViewFieldLongText from '@supertask/modules/database/components/view/grid/fields/FunctionalGridViewFieldLongText'
import FunctionalGridViewFieldText from '@supertask/modules/database/components/view/grid/fields/FunctionalGridViewFieldText'
import FunctionalGridViewFieldBlank from '@supertask/modules/database/components/view/grid/fields/FunctionalGridViewFieldBlank'
import FunctionalGridViewFieldArray from '@supertask/modules/database/components/view/grid/fields/FunctionalGridViewFieldArray'
import FunctionalGridViewFieldButton from '@supertask/modules/database/components/view/grid/fields/FunctionalGridViewFieldButton'
import FunctionalGridViewFieldLinkURL from '@supertask/modules/database/components/view/grid/fields/FunctionalGridViewFieldLinkURL'
import GridViewFieldArray from '@supertask/modules/database/components/view/grid/fields/GridViewFieldArray'
import RowEditFieldSingleSelectReadOnly from '@supertask/modules/database/components/row/RowEditFieldSingleSelectReadOnly'
import RowEditFieldMultipleSelectReadOnly from '@supertask/modules/database/components/row/RowEditFieldMultipleSelectReadOnly'
import RowEditFieldMultipleCollaboratorsReadOnly from '@supertask/modules/database/components/row/RowEditFieldMultipleCollaboratorsReadOnly'
import RowEditFieldArray from '@supertask/modules/database/components/row/RowEditFieldArray'
import RowEditFieldLinkURL from '@supertask/modules/database/components/row/RowEditFieldLinkURL'
import RowEditFieldButton from '@supertask/modules/database/components/row/RowEditFieldButton'
import RowEditFieldDurationReadOnly from '@supertask/modules/database/components/row/RowEditFieldDurationReadOnly'
import FunctionalFormulaArrayItem from '@supertask/modules/database/components/formula/array/FunctionalFormulaArrayItem'
import FunctionalFormulaArrayDurationItem from '@supertask/modules/database/components/formula/array/FunctionalFormulaArrayDurationItem'
import FunctionalFormulaArrayNumberItem from '@supertask/modules/database/components/formula/array/FunctionalFormulaArrayNumberItem'
import FunctionalFormulaBooleanArrayItem from '@supertask/modules/database/components/formula/array/FunctionalFormulaBooleanArrayItem'
import FunctionalFormulaDateArrayItem from '@supertask/modules/database/components/formula/array/FunctionalFormulaDateArrayItem'
import FunctionalFormulaSingleSelectArrayItem from '@supertask/modules/database/components/formula/array/FunctionalFormulaSingleSelectArrayItem'
import FunctionalFormulaMultipleSelectArrayItem from '@supertask/modules/database/components/formula/array/FunctionalFormulaMultipleSelectArrayItem'
import FunctionalFormulaMultipleCollaboratorsArrayItem from '@supertask/modules/database/components/formula/array/FunctionalFormulaMultipleCollaboratorsArrayItem'
import FunctionalFormulaLinkArrayItem from '@supertask/modules/database/components/formula/array/FunctionalFormulaLinkArrayItem'
import FunctionalFormulaButtonArrayItem from '@supertask/modules/database/components/formula/array/FunctionalFormulaButtonArrayItem'
import RowCardFieldArray from '@supertask/modules/database/components/card/RowCardFieldArray'
import RowEditFieldBlank from '@supertask/modules/database/components/row/RowEditFieldBlank'
import RowCardFieldBlank from '@supertask/modules/database/components/card/RowCardFieldBlank'
import RowCardFieldLinkURL from '@supertask/modules/database/components/card/RowCardFieldLinkURL'
import RowCardFieldButton from '@supertask/modules/database/components/card/RowCardFieldButton'
import GridViewFieldButton from '@supertask/modules/database/components/view/grid/fields/GridViewFieldButton'
import GridViewFieldLinkURL from '@supertask/modules/database/components/view/grid/fields/GridViewFieldLinkURL'
import GridViewFieldText from '@supertask/modules/database/components/view/grid/fields/GridViewFieldText'
import RowEditFieldFileReadOnly from '@supertask/modules/database/components/row/RowEditFieldFileReadOnly'
import FunctionalGridViewSingleFile from '@supertask/modules/database/components/view/grid/fields/FunctionalGridViewSingleFile'
import FunctionalFormulaFileArrayItem from '@supertask/modules/database/components/formula/array/FunctionalFormulaFileArrayItem'
import SingleFileArrayModal from '@supertask/modules/database/components/view/grid/fields/SingleFileArrayModal'
import GridViewSingleFile from '@supertask/modules/database/components/view/grid/fields/GridViewSingleFile'
import RowEditSingleFileReadOnly from '@supertask/modules/database/components/row/RowEditSingleFileReadOnly'
import RowCardFieldSingleFile from '@supertask/modules/database/components/card/RowCardFieldSingleFile'
import RowEditFieldURL from '@supertask/modules/database/components/row/RowEditFieldURL'
import FunctionalGridViewFieldURL from '@supertask/modules/database/components/view/grid/fields/FunctionalGridViewFieldURL'
import GridViewFieldURL from '@supertask/modules/database/components/view/grid/fields/GridViewFieldURL'
import RowCardFieldURL from '@supertask/modules/database/components/card/RowCardFieldURL'
import FunctionalFormulaURLArrayItem from '@supertask/modules/database/components/formula/array/FunctionalFormulaURLArrayItem'
import { mix } from '@supertask/modules/core/mixins'
import {
  hasEmptyValueFilterMixin,
  hasValueEqualFilterMixin,
  hasValueContainsFilterMixin,
  hasValueContainsWordFilterMixin,
  hasValueLengthIsLowerThanFilterMixin,
  hasSelectOptionIdEqualMixin,
  hasSelectOptionValueContainsFilterMixin,
  hasSelectOptionValueContainsWordFilterMixin,
  supertaskFormulaArrayTypeFilterMixin,
  hasNumericValueComparableToFilterMixin,
  hasNestedSelectOptionValueContainsFilterMixin,
  hasNestedSelectOptionValueContainsWordFilterMixin,
  hasMultipleSelectOptionIdEqualMixin,
} from '@supertask/modules/database/arrayFilterMixins'
import _ from 'lodash'
import ViewFilterTypeBoolean from '@supertask/modules/database/components/view/ViewFilterTypeBoolean'
import {
  genericHasAllValuesEqualFilter,
  genericHasValueContainsFilter,
  genericHasValueContainsWordFilter,
} from '@supertask/modules/database/utils/fieldFilters'
import ViewFilterTypeDuration from '@supertask/modules/database/components/view/ViewFilterTypeDuration'
import ViewFilterTypeMultipleSelectOptions from '@supertask/modules/database/components/view/ViewFilterTypeMultipleSelectOptions'
import { DEFAULT_SORT_TYPE_KEY } from '@supertask/modules/database/constants'
import ViewFilterTypeCollaborators from '@supertask/modules/database/components/view/ViewFilterTypeCollaborators'

export class SupertaskFormulaTypeDefinition extends Registerable {
  getIconClass() {
    throw new Error(
      'Not implemented error. This method should return the types icon.'
    )
  }

  getRowEditFieldComponent(field) {
    throw new Error(
      'Not implemented error. This method should return the types row edit component.'
    )
  }

  getFilterInputComponent(field, filterType) {
    return this.app.$registry
      .get('field', this.getFieldType())
      .getFilterInputComponent(field, filterType)
  }

  getRowEditArrayFieldComponent() {
    return null
  }

  parseFilterValue(field, value) {
    return this.app.$registry
      .get('field', this.getFieldType())
      .parseFilterValue(field, value)
  }

  formatFilterValue(field, value) {
    return this.app.$registry
      .get('field', this.getFieldType())
      .formatFilterValue(field, value)
  }

  getFunctionalGridViewFieldComponent() {
    return this.app.$registry
      .get('field', this.getFieldType())
      .getFunctionalGridViewFieldComponent()
  }

  getGridViewFieldComponent() {
    return this.app.$registry
      .get('field', this.getFieldType())
      .getGridViewFieldComponent()
  }

  getFieldType() {
    throw new Error(
      'Not implemented error. This method should return the types corresponding' +
        ' Supertask field type that should be used for things like sort indicators etc.'
    )
  }

  getSortOrder() {
    throw new Error(
      'Not implemented error. This method should return a number indicating how it ' +
        'should be sorted compared to other formula types when displayed.'
    )
  }

  getDocsResponseExample(field) {
    return this.app.$registry
      .get('field', this.getFieldType())
      .getDocsResponseExample(field)
  }

  getDocsDataType(field) {
    return this.app.$registry
      .get('field', this.getFieldType())
      .getDocsDataType(field)
  }

  prepareValueForCopy(field, value) {
    return this.app.$registry
      .get('field', this.getFieldType())
      .prepareValueForCopy(field, value)
  }

  parseInputValue(field, value) {
    return this.app.$registry
      .get('field', this.getFieldType())
      .parseInputValue(field, value)
  }

  getCardComponent() {
    return this.app.$registry
      .get('field', this.getFieldType())
      .getCardComponent()
  }

  getFunctionalFieldArrayComponent() {
    return FunctionalFormulaArrayItem
  }

  getCanSortInView(field) {
    return true
  }

  canBeSortedWhenInArray(field) {
    return false
  }

  getItemIsInNestedValueObjectWhenInArray() {
    return true
  }

  /**
   * The extra modal is a component that can be opened by emitting the `show` event up.
   */
  getExtraModal() {
    return null
  }

  getSort(name, order, field) {
    const underlyingFieldType = this.app.$registry.get(
      'field',
      this.getFieldType()
    )
    return underlyingFieldType.getSort(name, order, field)
  }

  getSortTypes(field) {
    const underlyingFieldType = this.app.$registry.get(
      'field',
      this.getFieldType()
    )
    const fieldSortTypes = underlyingFieldType.getSortTypes(field)
    // Only the default sort type is supported for formulas at the moment because
    // there is no way to configure different types in the backend.
    return {
      [DEFAULT_SORT_TYPE_KEY]: fieldSortTypes[DEFAULT_SORT_TYPE_KEY],
    }
  }

  _mapFormulaTypeToFieldType(formulaType) {
    return this.app.$registry.get('formula_type', formulaType).getFieldType()
  }

  getSortIndicator(field) {
    const underlyingFieldType = this.app.$registry.get(
      'field',
      this._mapFormulaTypeToFieldType(field.formula_type)
    )
    return underlyingFieldType.getSortIndicator()
  }

  mapToSortableArray(element) {
    return this.getItemIsInNestedValueObjectWhenInArray()
      ? element.value
      : element
  }

  toHumanReadableString(field, value) {
    const underlyingFieldType = this.app.$registry.get(
      'field',
      this.getFieldType()
    )
    return underlyingFieldType.toHumanReadableString(field, value)
  }

  canRepresentDate() {
    return false
  }

  canGroupByInView() {
    return false
  }

  isEqual(field, value1, value2) {
    const underlyingFieldType = this.app.$registry.get(
      'field',
      this._mapFormulaTypeToFieldType(field.formula_type)
    )
    return underlyingFieldType.isEqual(field, value1, value2)
  }

  getRowValueFromGroupValue(field, value) {
    const underlyingFieldType = this.app.$registry.get(
      'field',
      this._mapFormulaTypeToFieldType(field.formula_type)
    )
    return underlyingFieldType.getRowValueFromGroupValue(field, value)
  }

  getGroupValueFromRowValue(field, value) {
    const underlyingFieldType = this.app.$registry.get(
      'field',
      this._mapFormulaTypeToFieldType(field.formula_type)
    )
    return underlyingFieldType.getGroupValueFromRowValue(field, value)
  }

  canRepresentFiles(field) {
    return false
  }

  toSupertaskFormulaType(field) {
    return this.getType()
  }

  parseFromLinkedRowItemValue(field, value) {
    const underlyingFieldType = this.app.$registry.get(
      'field',
      this._mapFormulaTypeToFieldType(field.formula_type)
    )
    return underlyingFieldType.parseFromLinkedRowItemValue(field, value)
  }
}

export class SupertaskFormulaTextType extends mix(
  hasEmptyValueFilterMixin,
  hasValueEqualFilterMixin,
  hasValueContainsFilterMixin,
  hasValueContainsWordFilterMixin,
  hasValueLengthIsLowerThanFilterMixin,
  SupertaskFormulaTypeDefinition
) {
  static getType() {
    return 'text'
  }

  getFieldType() {
    return 'text'
  }

  getIconClass() {
    return 'iconoir-text'
  }

  getRowEditFieldComponent(field) {
    return RowEditFieldLongText
  }

  getGridViewFieldComponent() {
    return GridViewFieldLongText
  }

  getFunctionalGridViewFieldComponent() {
    return FunctionalGridViewFieldLongText
  }

  getSortOrder() {
    return 1
  }

  canBeSortedWhenInArray(field) {
    return true
  }

  canGroupByInView() {
    return true
  }
}

export class SupertaskFormulaCharType extends mix(
  hasEmptyValueFilterMixin,
  hasValueEqualFilterMixin,
  hasValueContainsFilterMixin,
  hasValueContainsWordFilterMixin,
  hasValueLengthIsLowerThanFilterMixin,
  SupertaskFormulaTypeDefinition
) {
  static getType() {
    return 'char'
  }

  getFieldType() {
    return 'text'
  }

  getIconClass() {
    return 'iconoir-text'
  }

  getRowEditFieldComponent(field) {
    return RowEditFieldText
  }

  getFunctionalGridViewFieldComponent() {
    return FunctionalGridViewFieldText
  }

  getSortOrder() {
    return 1
  }

  canBeSortedWhenInArray(field) {
    return true
  }

  canGroupByInView() {
    return true
  }
}

export class SupertaskFormulaNumberType extends mix(
  hasEmptyValueFilterMixin,
  hasValueContainsFilterMixin,
  hasNumericValueComparableToFilterMixin,

  SupertaskFormulaTypeDefinition
) {
  static getType() {
    return 'number'
  }

  getFieldType() {
    return 'number'
  }

  getIconClass() {
    return 'supertask-icon-hashtag'
  }

  getRowEditFieldComponent(field) {
    return RowEditFieldNumber
  }

  getFunctionalFieldArrayComponent() {
    return FunctionalFormulaArrayNumberItem
  }

  getSortOrder() {
    return 2
  }

  canBeSortedWhenInArray(field) {
    return true
  }

  canGroupByInView() {
    return true
  }
}

export class SupertaskFormulaBooleanType extends SupertaskFormulaTypeDefinition {
  static getType() {
    return 'boolean'
  }

  getFieldType() {
    return 'boolean'
  }

  getIconClass() {
    return 'supertask-icon-circle-checked'
  }

  getRowEditFieldComponent(field) {
    return RowEditFieldBoolean
  }

  getSortOrder() {
    return 3
  }

  getFunctionalFieldArrayComponent() {
    return FunctionalFormulaBooleanArrayItem
  }

  canBeSortedWhenInArray(field) {
    return true
  }

  canGroupByInView() {
    return true
  }

  getFilterInputComponent(field, filterType) {
    return ViewFilterTypeBoolean
  }

  getHasAllValuesEqualFilterFunction(field) {
    return (cellValue, filterValue) => {
      const parsedValue = this.parseInputValue(field, filterValue)
      return genericHasAllValuesEqualFilter(cellValue, parsedValue)
    }
  }

  getHasValueContainsFilterFunction(field) {
    return (cellValue, filterValue) => {
      const parsedValue = this.parseInputValue(field, filterValue)
      return genericHasValueContainsFilter(cellValue, parsedValue)
    }
  }

  getHasValueEqualFilterFunction(field) {
    return this.app.$registry
      .get('field', this.getFieldType())
      .getHasValueEqualFilterFunction(field)
  }

  parseInputValue(field, filterValue) {
    if (filterValue === '') {
      return false
    }
    return super.parseInputValue(field, filterValue)
  }
}

export class SupertaskFormulaDateType extends mix(
  hasEmptyValueFilterMixin,
  hasValueContainsFilterMixin,
  SupertaskFormulaTypeDefinition
) {
  static getType() {
    return 'date'
  }

  getFieldType() {
    return 'date'
  }

  getIconClass() {
    return 'iconoir-calendar'
  }

  getRowEditFieldComponent(field) {
    return RowEditFieldDateReadOnly
  }

  getSortOrder() {
    return 4
  }

  getFunctionalFieldArrayComponent() {
    return FunctionalFormulaDateArrayItem
  }

  canRepresentDate() {
    return true
  }

  canBeSortedWhenInArray(field) {
    return true
  }

  mapToSortableArray(element) {
    return element.value
  }

  canGroupByInView() {
    return true
  }
}

export class SupertaskFormulaDurationType extends mix(
  hasEmptyValueFilterMixin,
  hasNumericValueComparableToFilterMixin,
  SupertaskFormulaTypeDefinition
) {
  static getType() {
    return 'duration'
  }

  getFieldType() {
    return 'duration'
  }

  getIconClass() {
    return 'iconoir-clock-rotate-right'
  }

  getRowEditFieldComponent(field) {
    return RowEditFieldDurationReadOnly
  }

  getFilterInputComponent(field, filterType) {
    return ViewFilterTypeDuration
  }

  getSortOrder() {
    return 5
  }

  canGroupByInView() {
    return true
  }

  getFunctionalFieldArrayComponent() {
    return FunctionalFormulaArrayDurationItem
  }

  canBeSortedWhenInArray(field) {
    return true
  }
}

// Deprecated, use SupertaskFormulaDurationType instead.
export class SupertaskFormulaDateIntervalType extends SupertaskFormulaTypeDefinition {
  static getType() {
    return 'date_interval'
  }

  getFieldType() {
    return 'text'
  }

  getIconClass() {
    return 'supertask-icon-history'
  }

  getRowEditFieldComponent(field) {
    return RowEditFieldText
  }

  getGridViewFieldComponent() {
    return GridViewFieldText
  }

  getFunctionalGridViewFieldComponent() {
    return FunctionalGridViewFieldText
  }

  getSortOrder() {
    return 5
  }

  canGroupByInView() {
    return true
  }
}

// This type only exists in the frontend and only is referenced by a few weird frontend
// function defs which we want to show as a 'special' type in the GUI.
export class SupertaskFormulaSpecialType extends SupertaskFormulaTypeDefinition {
  static getType() {
    return 'special'
  }

  getFieldType() {
    return 'text'
  }

  getIconClass() {
    return 'supertask-icon-formula'
  }

  getRowEditFieldComponent(field) {
    return RowEditFieldText
  }

  getFunctionalGridViewFieldComponent() {
    return FunctionalGridViewFieldText
  }

  getSortOrder() {
    return 6
  }
}

export class SupertaskFormulaInvalidType extends SupertaskFormulaTypeDefinition {
  static getType() {
    return 'invalid'
  }

  getFieldType() {
    return 'text'
  }

  getIconClass() {
    return 'iconoir-warning-triangle'
  }

  getCardComponent() {
    return RowCardFieldBlank
  }

  getRowEditFieldComponent(field) {
    return RowEditFieldBlank
  }

  getFunctionalGridViewFieldComponent() {
    return FunctionalGridViewFieldBlank
  }

  getSortOrder() {
    return 9
  }

  getCanSortInView(field) {
    return false
  }
}

export class SupertaskFormulaArrayType extends mix(
  supertaskFormulaArrayTypeFilterMixin,
  SupertaskFormulaTypeDefinition
) {
  static getType() {
    return 'array'
  }

  getFieldType(field) {
    return 'text'
  }

  parseInputValue(field, value) {
    return this.getSubType(field)?.parseInputValue(field, value)
  }

  getIconClass() {
    return 'iconoir-list'
  }

  getCardComponent() {
    return RowCardFieldArray
  }

  parseFilterValue(field, value) {
    const subType = this.getSubType(field)
    if (subType == null) {
      return value
    }
    return subType.parseFilterValue(field, value)
  }

  formatFilterValue(field, value) {
    const subType = this.getSubType(field)
    if (subType == null) {
      return value
    }
    return subType.formatFilterValue(field, value)
  }

  getSubType(field) {
    return this.app.$registry.get('formula_type', field.array_formula_type)
  }

  getRowEditFieldComponent(field) {
    const arrayOverride =
      this.getSubType(field)?.getRowEditArrayFieldComponent()
    if (arrayOverride) {
      return arrayOverride
    } else {
      return RowEditFieldArray
    }
  }

  getFilterInputComponent(field, filterType) {
    return this.getSubType(field)?.getFilterInputComponent(field, filterType)
  }

  getFunctionalGridViewFieldComponent() {
    return FunctionalGridViewFieldArray
  }

  getGridViewFieldComponent() {
    return GridViewFieldArray
  }

  getSortOrder() {
    return 7
  }

  prepareValueForCopy(field, value) {
    const subType = this.getSubType(field)
    return value
      .map((v) => {
        return subType.prepareValueForCopy(
          field,
          subType.getItemIsInNestedValueObjectWhenInArray() ? v.value : v
        )
      })
      .join(', ')
  }

  getDocsResponseExample(field) {
    if (field.array_formula_type != null) {
      const subType = this.getSubType(field)
      const value = this.app.$registry
        .get('formula_type', field.array_formula_type)
        .getDocsResponseExample(field)
      if (subType.getItemIsInNestedValueObjectWhenInArray()) {
        return [{ id: 0, value }]
      } else {
        return [value]
      }
    } else {
      return null
    }
  }

  getDocsDataType(field) {
    return 'array'
  }

  getCanSortInView(field) {
    const subType = this.getSubType(field)
    return subType.canBeSortedWhenInArray(field)
  }

  canRepresentFiles(field) {
    const subType = this.getSubType(field)
    return subType.canRepresentFiles(field)
  }

  getSort(name, order, field) {
    const subType = this.getSubType(field)

    const innerSortFunction = subType.getSort(name, order, field)

    return (a, b) => {
      const valA = Array.isArray(a[name]) ? a[name] : [a[name]]
      const valB = Array.isArray(b[name]) ? b[name] : [b[name]]
      const valuesA = valA.map(subType.mapToSortableArray.bind(subType))
      const valuesB = valB.map(subType.mapToSortableArray.bind(subType))

      for (let i = 0; i < Math.max(valuesA.length, valuesB.length); i++) {
        let compared = 0

        const isAdefined = valuesA[i] || valuesA[i] === ''
        const isBdefined = valuesB[i] || valuesB[i] === ''

        if (isAdefined && isBdefined) {
          compared = innerSortFunction(
            { [name]: valuesA[i] },
            { [name]: valuesB[i] }
          )
        } else if (
          isAdefined &&
          (valuesB[i] === undefined || valuesB[i] === false)
        ) {
          compared = order === 'ASC' ? 1 : -1
        } else if (
          isBdefined &&
          (valuesA[i] === undefined || valuesA[i] === false)
        ) {
          compared = order === 'ASC' ? -1 : 1
        } else if (isAdefined && valuesB[i] === null) {
          compared = order === 'ASC' ? -1 : 1
        } else if (isBdefined && valuesA[i] === null) {
          compared = order === 'ASC' ? 1 : -1
        } else if (valuesA[i] === null && valuesB[i] === undefined) {
          compared = order === 'ASC' ? 1 : -1
        } else if (valuesA[i] === undefined && valuesB[i] === null) {
          compared = order === 'ASC' ? -1 : 1
        } else if (valuesA[i] === false && valuesB[i] !== false) {
          compared = order === 'ASC' ? 1 : -1
        } else if (valuesA[i] !== false && valuesB[i] === false) {
          compared = order === 'ASC' ? -1 : 1
        }

        if (compared !== 0) {
          return compared
        }
      }
    }
  }

  getSortIndicator(field) {
    const underlyingFieldType = this.app.$registry.get(
      'field',
      this._mapFormulaTypeToFieldType(field.array_formula_type)
    )
    return underlyingFieldType.getSortIndicator()
  }

  toHumanReadableString(field, value) {
    const subType = this.getSubType(field)
    if (!Array.isArray(value)) {
      return ''
    }

    return value
      .map((v) => {
        return subType.toHumanReadableString(
          field,
          subType.getItemIsInNestedValueObjectWhenInArray() ? v.value : v
        )
      })
      .join(', ')
  }

  canGroupByInView() {
    return false
  }

  toSupertaskFormulaType(field) {
    return this.getSubType(field)?.toSupertaskFormulaType(field)
  }

  parseFromLinkedRowItemValue(field, value) {
    const subType = this.getSubType(field)
    return subType.parseFromLinkedRowItemValue(field, value)
  }
}

export class SupertaskFormulaFileType extends SupertaskFormulaTypeDefinition {
  static getType() {
    return 'single_file'
  }

  getFieldType() {
    return 'file'
  }

  getIconClass() {
    return 'iconoir-empty-page'
  }

  getRowEditArrayFieldComponent() {
    return RowEditFieldFileReadOnly
  }

  getRowEditFieldComponent(field) {
    return RowEditSingleFileReadOnly
  }

  getItemIsInNestedValueObjectWhenInArray() {
    return false
  }

  getFunctionalGridViewFieldComponent() {
    return FunctionalGridViewSingleFile
  }

  getGridViewFieldComponent() {
    return GridViewSingleFile
  }

  getFunctionalFieldArrayComponent() {
    return FunctionalFormulaFileArrayItem
  }

  getExtraModal() {
    return SingleFileArrayModal
  }

  getSortOrder() {
    return 11
  }

  getCanSortInView(field) {
    return false
  }

  canBeSortedWhenInArray(field) {
    return false
  }

  canGroupByInView() {
    return false
  }

  getDocsResponseExample(field) {
    return {
      url: 'https://files.example.com/user_files/VXotniBOVm8tbstZkKsMKbj2Qg7KmPvn_39d354a76abe56baaf569ad87d0333f58ee4bf3eed368e3b9dc736fd18b09dfd.png',
      thumbnails: {
        tiny: {
          url: 'https://files.example.com/media/thumbnails/tiny/VXotniBOVm8tbstZkKsMKbj2Qg7KmPvn_39d354a76abe56baaf569ad87d0333f58ee4bf3eed368e3b9dc736fd18b09dfd.png',
          width: 21,
          height: 21,
        },
        small: {
          url: 'https://files.example.com/media/thumbnails/small/VXotniBOVm8tbstZkKsMKbj2Qg7KmPvn_39d354a76abe56baaf569ad87d0333f58ee4bf3eed368e3b9dc736fd18b09dfd.png',
          width: 48,
          height: 48,
        },
      },
      name: 'VXotniBOVm8tbstZkKsMKbj2Qg7KmPvn_39d354a76abe56baaf569ad87d0333f58ee4bf3eed368e3b9dc736fd18b09dfd.png',
      size: 229940,
      mime_type: 'image/png',
      is_image: true,
      image_width: 1280,
      image_height: 585,
      uploaded_at: '2020-11-17T12:16:10.035234+00:00',
    }
  }

  getDocsDataType(field) {
    return 'single_file'
  }

  prepareValueForCopy(field, value) {
    return `${value?.visible_name} (${value?.url})`
  }

  getCardComponent() {
    return RowCardFieldSingleFile
  }

  toHumanReadableString(field, value) {
    return value?.visible_name || ''
  }

  canRepresentFiles(field) {
    return true
  }
}

export class SupertaskFormulaSingleSelectType extends mix(
  hasEmptyValueFilterMixin,
  hasSelectOptionIdEqualMixin,
  hasSelectOptionValueContainsFilterMixin,
  hasSelectOptionValueContainsWordFilterMixin,
  SupertaskFormulaTypeDefinition
) {
  static getType() {
    return 'single_select'
  }

  getFieldType() {
    return 'single_select'
  }

  getIconClass() {
    return 'supertask-icon-single-select'
  }

  getRowEditFieldComponent(field) {
    return RowEditFieldSingleSelectReadOnly
  }

  getFunctionalFieldArrayComponent() {
    return FunctionalFormulaSingleSelectArrayItem
  }

  getFilterInputComponent(field, filterType) {
    return ViewFilterTypeMultipleSelectOptions
  }

  getSortOrder() {
    return 8
  }

  getCanSortInView(field) {
    return true
  }

  canBeSortedWhenInArray(field) {
    return true
  }

  mapToSortableArray(element) {
    return element.value
  }

  canGroupByInView() {
    return false
  }
}

export class SupertaskFormulaMultipleSelectType extends mix(
  hasEmptyValueFilterMixin,
  hasNestedSelectOptionValueContainsFilterMixin,
  hasNestedSelectOptionValueContainsWordFilterMixin,
  hasMultipleSelectOptionIdEqualMixin,
  SupertaskFormulaTypeDefinition
) {
  static getType() {
    return 'multiple_select'
  }

  getFieldType() {
    return 'multiple_select'
  }

  getIconClass() {
    return 'supertask-icon-multiple-select'
  }

  getFilterInputComponent(field, filterType) {
    return ViewFilterTypeMultipleSelectOptions
  }

  getRowEditFieldComponent(field) {
    return RowEditFieldMultipleSelectReadOnly
  }

  getFunctionalFieldArrayComponent() {
    return FunctionalFormulaMultipleSelectArrayItem
  }

  getSortOrder() {
    return 8
  }

  getCanSortInView(field) {
    return false
  }

  canBeSortedWhenInArray(field) {
    return false
  }

  mapToSortableArray(element) {
    return element.value
  }

  canGroupByInView() {
    return false
  }
}

export class SupertaskFormulaMultipleCollaboratorsType extends mix(
  hasEmptyValueFilterMixin,
  hasNestedSelectOptionValueContainsFilterMixin,
  hasNestedSelectOptionValueContainsWordFilterMixin,
  hasMultipleSelectOptionIdEqualMixin,
  SupertaskFormulaTypeDefinition
) {
  static getType() {
    return 'multiple_collaborators'
  }

  getFieldType() {
    return 'multiple_collaborators'
  }

  getIconClass() {
    return 'iconoir-community'
  }

  getFilterInputComponent(field, filterType) {
    return ViewFilterTypeCollaborators
  }

  getRowEditFieldComponent(field) {
    return RowEditFieldMultipleCollaboratorsReadOnly
  }

  getFunctionalFieldArrayComponent() {
    return FunctionalFormulaMultipleCollaboratorsArrayItem
  }

  getSortOrder() {
    return 8
  }

  getCanSortInView(field) {
    return false
  }

  canBeSortedWhenInArray(field) {
    return false
  }

  mapToSortableArray(element) {
    return element.value
  }

  canGroupByInView() {
    return false
  }

  _getHasValueEqualFilterFunctionForRowValues(rowValueIdSets, filterValues) {
    return rowValueIdSets.some((rowValueIdSet) =>
      rowValueIdSet.isSupersetOf(new Set(filterValues))
    )
  }

  _getHasValueContainsFilterFunction(cellValue, filterValue) {
    return cellValue.some((v) =>
      genericHasValueContainsFilter(v?.value || [], filterValue, 'name')
    )
  }

  _getHasValueContainsWordFilterFunction(cellValue, filterValue) {
    return cellValue.some((v) =>
      genericHasValueContainsWordFilter(v?.value || [], filterValue, 'name')
    )
  }
}

export class SupertaskFormulaLinkType extends SupertaskFormulaTypeDefinition {
  static getType() {
    return 'link'
  }

  getFieldType() {
    return 'text'
  }

  getIconClass() {
    return 'iconoir-link'
  }

  getRowEditFieldComponent(field) {
    return RowEditFieldLinkURL
  }

  getFunctionalGridViewFieldComponent() {
    return FunctionalGridViewFieldLinkURL
  }

  getGridViewFieldComponent() {
    return GridViewFieldLinkURL
  }

  getSortOrder() {
    return 10
  }

  getFunctionalFieldArrayComponent() {
    return FunctionalFormulaLinkArrayItem
  }

  toHumanReadableString(field, value) {
    if (value?.label) {
      return `${value.label} (${value.url})`
    } else {
      return value.url
    }
  }

  getCardComponent() {
    return RowCardFieldLinkURL
  }

  prepareValueForCopy(field, value) {
    return this.toHumanReadableString(field, value)
  }

  getCanSortInView(field) {
    return false
  }

  canGroupByInView() {
    return false
  }
}

export class SupertaskFormulaURLType extends mix(
  hasEmptyValueFilterMixin,
  hasValueEqualFilterMixin,
  hasValueContainsFilterMixin,
  hasValueContainsWordFilterMixin,
  hasValueLengthIsLowerThanFilterMixin,
  SupertaskFormulaTypeDefinition
) {
  static getType() {
    return 'url'
  }

  getFieldType() {
    return 'url'
  }

  getIconClass() {
    return 'iconoir-link'
  }

  getRowEditFieldComponent(field) {
    return RowEditFieldURL
  }

  getFunctionalGridViewFieldComponent() {
    return FunctionalGridViewFieldURL
  }

  getGridViewFieldComponent() {
    return GridViewFieldURL
  }

  getSortOrder() {
    return 10
  }

  getFunctionalFieldArrayComponent() {
    return FunctionalFormulaURLArrayItem
  }

  toHumanReadableString(field, value) {
    if (_.isString(value)) {
      return value
    }
    if (value?.label) {
      return `${value.label} (${value.url})`
    } else {
      return value.url
    }
  }

  getCardComponent() {
    return RowCardFieldURL
  }

  prepareValueForCopy(field, value) {
    return this.toHumanReadableString(field, value)
  }

  getCanSortInView(field) {
    return false
  }

  canGroupByInView() {
    return false
  }
}

export class SupertaskFormulaButtonType extends SupertaskFormulaLinkType {
  static getType() {
    return 'button'
  }

  getRowEditFieldComponent(field) {
    return RowEditFieldButton
  }

  getFunctionalGridViewFieldComponent() {
    return FunctionalGridViewFieldButton
  }

  getGridViewFieldComponent() {
    return GridViewFieldButton
  }

  getCardComponent() {
    return RowCardFieldButton
  }

  getFunctionalFieldArrayComponent() {
    return FunctionalFormulaButtonArrayItem
  }
}
