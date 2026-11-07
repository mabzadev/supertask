import { DatabaseApplicationType } from '@supertask/modules/database/applicationTypes'
import GridViewRowExpandButtonWithCommentCount from '@supertask_premium/components/row_comments/GridViewRowExpandButtonWithCommentCount'

export class PremiumDatabaseApplicationType extends DatabaseApplicationType {
  getRowExpandButtonComponent() {
    return GridViewRowExpandButtonWithCommentCount
  }
}
