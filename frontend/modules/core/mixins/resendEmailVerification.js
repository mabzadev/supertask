import AuthService from '@supertask/modules/core/services/auth'
import { notifyIf } from '@supertask/modules/core/utils/error'

export default {
  data() {
    return {
      resendLoading: false,
      resendSuccess: false,
    }
  },
  methods: {
    async resend(email) {
      if (this.resendLoading) {
        return
      }

      this.resendLoading = true

      try {
        await AuthService(this.$client).sendVerifyEmail(email)
        this.resendSuccess = true
        this.$store.dispatch('toast/info', {
          title: this.$t('resendEmailVerification.confirmationEmailSentTitle'),
          message: this.$t(
            'resendEmailVerification.confirmationEmailSentDescription'
          ),
        })
      } catch (error) {
        notifyIf(error, 'emailVerification')
      }

      this.resendLoading = false
    },
  },
}
