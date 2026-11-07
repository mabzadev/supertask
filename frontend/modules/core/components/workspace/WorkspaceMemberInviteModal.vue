<template>
  <Modal ref="modal">
    <h2 class="box__title">
      {{ $t('membersSettings.membersInviteModal.title') }}
    </h2>
    <Error :error="error"></Error>
    <Alert v-if="!canCreateAccounts" type="info" class="margin-bottom-2">
      {{ $t('membersSettings.membersInviteModal.existingAccountsOnly') }}
    </Alert>
    <WorkspaceInviteForm
      ref="inviteForm"
      :workspace="workspace"
      @submitted="inviteSubmitted"
    >
      <template #default>
        <div class="col col-12 align-right">
          <Button
            type="primary"
            :loading="inviteLoading"
            :disabled="inviteLoading"
          >
            {{ $t('membersSettings.membersInviteModal.submit') }}
          </Button>
        </div>
      </template>
      <template #roleSelectorLabel>
        <HelpIcon
          class="margin-right-1"
          :tooltip="$t('membersSettings.membersInviteModal.helpIconText')"
        />
      </template>
    </WorkspaceInviteForm>
  </Modal>
</template>

<script>
import modal from '@supertask/modules/core/mixins/modal'
import error from '@supertask/modules/core/mixins/error'
import WorkspaceInviteForm from '@supertask/modules/core/components/workspace/WorkspaceInviteForm'
import WorkspaceService from '@supertask/modules/core/services/workspace'
import { ResponseErrorMessage } from '@supertask/modules/core/plugins/clientHandler'

export default {
  name: 'MembersInviteModal',
  components: { WorkspaceInviteForm },
  mixins: [modal, error],
  props: {
    workspace: {
      type: Object,
      required: true,
    },
  },
  emits: ['invite-submitted'],
  data() {
    return {
      inviteLoading: false,
    }
  },
  computed: {
    canCreateAccounts() {
      return Boolean(this.$store.getters['auth/getUserObject']?.can_create_accounts)
    },
  },
  methods: {
    async inviteSubmitted(values) {
      this.inviteLoading = true
      this.hideError()

      try {
        // The public accept url is the page where the user can publicly navigate too,
        // to accept the workspace invitation.
        const acceptUrl = `${this.$config.public.supertaskEmbeddedShareUrl}/workspace-invitation`
        const { data } = await WorkspaceService(this.$client).sendInvitation(
          this.workspace.id,
          acceptUrl,
          values
        )
        this.$bus.$emit('invite-submitted', data)
        this.$emit('invite-submitted')
        this.hide()
      } catch (error) {
        this.handleError(error, 'workspace', {
          ERROR_GROUP_USER_ALREADY_EXISTS: new ResponseErrorMessage(
            this.$t(
              'membersSettings.membersInviteModal.errors.userAlreadyInWorkspace.title'
            ),
            this.$t(
              'membersSettings.membersInviteModal.errors.userAlreadyInWorkspace.text'
            )
          ),
          ERROR_ACCOUNT_CREATION_NOT_ALLOWED: new ResponseErrorMessage(
            this.$t(
              'membersSettings.membersInviteModal.errors.accountCreationNotAllowed.title'
            ),
            this.$t(
              'membersSettings.membersInviteModal.errors.accountCreationNotAllowed.text'
            )
          ),
          ERROR_EMAIL_NOT_ALLOWED: new ResponseErrorMessage(
            this.$t(
              'membersSettings.membersInviteModal.errors.emailNotAllowed.title'
            ),
            this.$t(
              'membersSettings.membersInviteModal.errors.emailNotAllowed.text'
            )
          ),
        })
      }

      this.inviteLoading = false
    },
  },
}
</script>
