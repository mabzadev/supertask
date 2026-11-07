import { isValidURL } from '@supertask/modules/core/utils/string'
import { ensureUrlProtocol } from '@supertask/modules/core/utils/url'

export default {
  methods: {
    isValid(value) {
      return isValidURL(value?.url)
    },
    getLabelOrURL(value) {
      if (!value) {
        return ''
      } else {
        return value.label ? value.label : value.url
      }
    },
    getHref(value) {
      return ensureUrlProtocol(value)
    },
  },
}
