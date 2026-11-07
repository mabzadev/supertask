import {
  DataSyncType,
  PostgreSQLDataSyncType as BasePostgreSQLDataSyncType,
} from '@supertask/modules/database/dataSyncTypes'

import LocalSupertaskTableDataSync from '@supertask_enterprise/components/dataSync/LocalSupertaskTableDataSync'
import EnterpriseFeatures from '@supertask_enterprise/features'
import GitHubIssuesDataSyncForm from '@supertask_enterprise/components/dataSync/GitHubIssuesDataSyncForm'
import PaidFeaturesModal from '@supertask_premium/components/PaidFeaturesModal'
import { DataSyncPaidFeature } from '@supertask_enterprise/paidFeatures'
import { RealtimePushTwoWaySyncStrategyType } from '@supertask_enterprise/twoWaySyncStrategyTypes'

export class LocalSupertaskTableDataSyncType extends DataSyncType {
  static getType() {
    return 'local_supertask_table'
  }

  getIconClass() {
    return 'iconoir-menu'
  }

  getName() {
    const { $i18n } = this.app
    return $i18n.t('enterpriseDataSyncType.localSupertaskTable')
  }

  getFormComponent() {
    return LocalSupertaskTableDataSync
  }

  isDeactivated(workspaceId) {
    return !this.app.$hasFeature(EnterpriseFeatures.DATA_SYNC, workspaceId)
  }

  getDeactivatedClickModal() {
    return [
      PaidFeaturesModal,
      { 'initial-selected-type': DataSyncPaidFeature.getType() },
    ]
  }
}

export class GitHubIssuesDataSyncType extends DataSyncType {
  static getType() {
    return 'github_issues'
  }

  getIconClass() {
    return 'iconoir-github'
  }

  getName() {
    const { $i18n } = this.app
    return $i18n.t('enterpriseDataSyncType.githubIssues')
  }

  getFormComponent() {
    return GitHubIssuesDataSyncForm
  }

  isDeactivated(workspaceId) {
    return !this.app.$hasFeature(EnterpriseFeatures.DATA_SYNC, workspaceId)
  }

  getDeactivatedClickModal() {
    return [
      PaidFeaturesModal,
      { 'initial-selected-type': DataSyncPaidFeature.getType() },
    ]
  }
}

export class PostgreSQLDataSyncType extends BasePostgreSQLDataSyncType {
  getTwoWayDataSyncStrategy() {
    return RealtimePushTwoWaySyncStrategyType.getType()
  }
}
