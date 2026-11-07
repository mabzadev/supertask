import { NotificationType } from '@supertask/modules/core/notificationTypes'

import PeriodicDataSyncDeactivatedNotification from '@supertask_enterprise/components/notifications/PeriodicDataSyncDeactivatedNotification'
import TwoWaySyncUpdateFailedNotification from '@supertask_enterprise/components/notifications/TwoWaySyncUpdateFailedNotification'
import TwoWaySyncDeactivatedNotification from '@supertask_enterprise/components/notifications/TwoWaySyncDeactivatedNotification'
import { PeriodicIntervalFieldsConfigureDataSyncType } from '@supertask_enterprise/configureDataSyncTypes'
import { SyncedFieldsConfigureDataSyncType } from '@supertask/modules/database/configureDataSyncTypes'
import { tableRouteResetViewIfNeeded } from '@supertask/modules/database/utils/routing'

export class PeriodicDataSyncDeactivatedNotificationType extends NotificationType {
  static getType() {
    return 'periodic_data_sync_deactivated'
  }

  getIconComponent() {
    return null
  }

  getContentComponent() {
    return PeriodicDataSyncDeactivatedNotification
  }

  getRoute(notificationData) {
    return tableRouteResetViewIfNeeded(
      {
        databaseId: notificationData.database_id,
        tableId: notificationData.table_id,
        selectedPage: PeriodicIntervalFieldsConfigureDataSyncType.getType(),
      },
      'database-table-open-configure-data-sync'
    )
  }
}

export class TwoWayDataSyncUpdateFiledNotificationType extends NotificationType {
  static getType() {
    return 'two_way_sync_update_failed'
  }

  getIconComponent() {
    return null
  }

  getContentComponent() {
    return TwoWaySyncUpdateFailedNotification
  }

  getRoute(notificationData) {
    return tableRouteResetViewIfNeeded(
      {
        databaseId: notificationData.database_id,
        tableId: notificationData.table_id,
        selectedPage: SyncedFieldsConfigureDataSyncType.getType(),
      },
      'database-table-open-configure-data-sync'
    )
  }
}

export class TwoWaySyncDeactivatedNotificationType extends NotificationType {
  static getType() {
    return 'two_way_sync_deactivated'
  }

  getIconComponent() {
    return null
  }

  getContentComponent() {
    return TwoWaySyncDeactivatedNotification
  }

  getRoute(notificationData) {
    return tableRouteResetViewIfNeeded(
      {
        databaseId: notificationData.database_id,
        tableId: notificationData.table_id,
        selectedPage: SyncedFieldsConfigureDataSyncType.getType(),
      },
      'database-table-open-configure-data-sync'
    )
  }
}
