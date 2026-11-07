import lowercase from '@supertask/modules/core/filters/lowercase'
import nameAbbreviation from '@supertask/modules/core/filters/nameAbbreviation'
import uppercase from '@supertask/modules/core/filters/uppercase'

export default defineNuxtPlugin((nuxtApp) => {
  return {
    provide: {
      filters: {
        lowercase,
        uppercase,
        nameAbbreviation,
      },
    },
  }
})
