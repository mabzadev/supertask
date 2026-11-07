<script>
import UserWorkspacesField from '@supertask/modules/core/components/admin/users/fields/UserWorkspacesField'

export default {
  name: 'WorkspaceUsersField',
  extends: UserWorkspacesField,
  data() {
    return {
      nameKey: 'email',
    }
  },
}
</script>
