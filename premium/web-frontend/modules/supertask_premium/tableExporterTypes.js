import { TableExporterType } from '@supertask/modules/database/exporterTypes'
import { GridViewType } from '@supertask/modules/database/viewTypes'
import TableJSONExporter from '@supertask_premium/components/exporter/TableJSONExporter'
import TableXMLExporter from '@supertask_premium/components/exporter/TableXMLExporter'
import PremiumFeatures from '@supertask_premium/features'
import TableExcelExporter from '@supertask_premium/components/exporter/TableExcelExporter'
import TableFileExporter from '@supertask_premium/components/exporter/TableFileExporter'
import PaidFeaturesModal from '@supertask_premium/components/PaidFeaturesModal'
import { ExportsPaidFeature } from '@supertask_premium/paidFeatures'

class PremiumTableExporterType extends TableExporterType {
  getDeactivatedText() {
    return this.app.$i18n.t('premium.deactivated')
  }

  getDeactivatedClickModal() {
    return [
      PaidFeaturesModal,
      { 'initial-selected-type': ExportsPaidFeature.getType() },
    ]
  }

  isDeactivated(workspaceId) {
    // If the user is looking a publicly shared view, then the feature must never be
    // deactivated because the check can't be done properly.
    const isPublic = this.app.$store.getters['page/view/public/getIsPublic']
    return (
      !this.app.$hasFeature(PremiumFeatures.PREMIUM, workspaceId) && !isPublic
    )
  }
}

export class JSONTableExporter extends PremiumTableExporterType {
  static getType() {
    return 'json'
  }

  getIconClass() {
    return 'supertask-icon-file-code'
  }

  getName() {
    const { $i18n } = this.app
    return $i18n.t('premium.exporterType.json')
  }

  getFormComponent() {
    return TableJSONExporter
  }

  getCanExportTable() {
    return true
  }

  getSupportedViews() {
    return [GridViewType.getType()]
  }
}

export class XMLTableExporter extends PremiumTableExporterType {
  static getType() {
    return 'xml'
  }

  getIconClass() {
    return 'supertask-icon-file-code'
  }

  getName() {
    const { $i18n } = this.app
    return $i18n.t('premium.exporterType.xml')
  }

  getFormComponent() {
    return TableXMLExporter
  }

  getCanExportTable() {
    return true
  }

  getSupportedViews() {
    return [GridViewType.getType()]
  }
}

export class ExcelTableExporterType extends PremiumTableExporterType {
  static getType() {
    return 'excel'
  }

  getFileExtension() {
    return 'xlsx'
  }

  getIconClass() {
    return 'supertask-icon-file-excel'
  }

  getName() {
    const { $i18n } = this.app
    return $i18n.t('premium.exporterType.excel')
  }

  getFormComponent() {
    return TableExcelExporter
  }

  getCanExportTable() {
    return true
  }

  getSupportedViews() {
    return [GridViewType.getType()]
  }
}

export class FileTableExporter extends PremiumTableExporterType {
  static getType() {
    return 'file'
  }

  getFileExtension() {
    return 'zip'
  }

  getIconClass() {
    return 'supertask-icon-file-code'
  }

  getName() {
    const { $i18n } = this.app
    return $i18n.t('premium.exporterType.file')
  }

  getFormComponent() {
    return TableFileExporter
  }

  getCanExportTable() {
    return true
  }

  getSupportedViews() {
    return [GridViewType.getType()]
  }
}
