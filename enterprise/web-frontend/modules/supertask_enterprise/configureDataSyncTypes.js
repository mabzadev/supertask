import { ConfigureDataSyncType } from '@supertask/modules/database/configureDataSyncTypes'
import ConfigureDataSyncPeriodicInterval from '@supertask_enterprise/components/dataSync/ConfigureDataSyncPeriodicInterval'

export class PeriodicIntervalFieldsConfigureDataSyncType extends ConfigureDataSyncType {
  static getType() {
    return 'periodic-interval'
  }

  get name() {
    return this.app.$i18n.t('configureDataSyncModal.periodicInterval')
  }

  get iconClass() {
    return 'iconoir-timer'
  }

  get component() {
    return ConfigureDataSyncPeriodicInterval
  }
}
