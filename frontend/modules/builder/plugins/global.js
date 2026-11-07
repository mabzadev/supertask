import ABButton from '@supertask/modules/builder/components/elements/baseComponents/ABButton'
import ABInput from '@supertask/modules/builder/components/elements/baseComponents/ABInput'
import ABFormGroup from '@supertask/modules/builder/components/elements/baseComponents/ABFormGroup'
import ABLink from '@supertask/modules/builder/components/elements/baseComponents/ABLink'
import ABHeading from '@supertask/modules/builder/components/elements/baseComponents/ABHeading'
import ABDropdown from '@supertask/modules/builder/components/elements/baseComponents/ABDropdown'
import ABDropdownItem from '@supertask/modules/builder/components/elements/baseComponents/ABDropdownItem'
import ABCheckbox from '@supertask/modules/builder/components/elements/baseComponents/ABCheckbox.vue'
import ABRadio from '@supertask/modules/builder/components/elements/baseComponents/ABRadio.vue'
import ABImage from '@supertask/modules/builder/components/elements/baseComponents/ABImage.vue'
import ABParagraph from '@supertask/modules/builder/components/elements/baseComponents/ABParagraph.vue'
import ABTag from '@supertask/modules/builder/components/elements/baseComponents/ABTag.vue'
import ABTable from '@supertask/modules/builder/components/elements/baseComponents/ABTable.vue'
import ABFileInput from '@supertask/modules/builder/components/elements/baseComponents/ABFileInput'
import ABAvatar from '@supertask/modules/builder/components/elements/baseComponents/ABAvatar'
import ABPresentation from '@supertask/modules/builder/components/elements/baseComponents/ABPresentation'
import ABIcon from '@supertask/modules/builder/components/elements/baseComponents/ABIcon'

export default defineNuxtPlugin((nuxtApp) => {
  // Register global components for Application Builder
  nuxtApp.vueApp.component('ABButton', ABButton)
  nuxtApp.vueApp.component('ABInput', ABInput)
  nuxtApp.vueApp.component('ABFormGroup', ABFormGroup)
  nuxtApp.vueApp.component('ABLink', ABLink)
  nuxtApp.vueApp.component('ABHeading', ABHeading)
  nuxtApp.vueApp.component('ABDropdown', ABDropdown)
  nuxtApp.vueApp.component('ABDropdownItem', ABDropdownItem)
  nuxtApp.vueApp.component('ABCheckbox', ABCheckbox)
  nuxtApp.vueApp.component('ABRadio', ABRadio)
  nuxtApp.vueApp.component('ABImage', ABImage)
  nuxtApp.vueApp.component('ABParagraph', ABParagraph)
  nuxtApp.vueApp.component('ABTag', ABTag)
  nuxtApp.vueApp.component('ABTable', ABTable)
  nuxtApp.vueApp.component('ABFileInput', ABFileInput)
  nuxtApp.vueApp.component('ABAvatar', ABAvatar)
  nuxtApp.vueApp.component('ABPresentation', ABPresentation)
  nuxtApp.vueApp.component('ABIcon', ABIcon)
})
