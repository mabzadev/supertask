import { Registerable } from '@supertask/modules/core/registry'
import FieldPermissionsContextItem from '@supertask_enterprise/components/fieldPermissions/FieldPermissionsContextItem'

export class FieldPermissionsContextItemType extends Registerable {
  static getType() {
    return 'field-permissions'
  }

  getComponent() {
    return FieldPermissionsContextItem
  }
}
