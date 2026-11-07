import { SupertaskPlugin } from '@supertask/modules/core/plugins'
import DatabaseDashboardResourceLinks from '@supertask/modules/database/components/dashboard/DatabaseDashboardResourceLinks'

export class DatabasePlugin extends SupertaskPlugin {
  static getType() {
    return 'database'
  }

  getDashboardResourceLinksComponent() {
    return DatabaseDashboardResourceLinks
  }
}
