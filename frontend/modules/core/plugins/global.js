import Alert from '@supertask/modules/core/components/Alert'
import Avatar from '@supertask/modules/core/components/Avatar'
import Badge from '@supertask/modules/core/components/Badge'
import BadgeCollaborator from '@supertask/modules/core/components/BadgeCollaborator'
import Button from '@supertask/modules/core/components/Button'
import ButtonAdd from '@supertask/modules/core/components/ButtonAdd'
import ButtonFloating from '@supertask/modules/core/components/ButtonFloating'
import ButtonIcon from '@supertask/modules/core/components/ButtonIcon'
import ButtonText from '@supertask/modules/core/components/ButtonText'
import CallToAction from '@supertask/modules/core/components/CallToAction.vue'
import Checkbox from '@supertask/modules/core/components/Checkbox'
import Chips from '@supertask/modules/core/components/Chips'
import ColorInput from '@supertask/modules/core/components/ColorInput'
import Context from '@supertask/modules/core/components/Context'
import Copied from '@supertask/modules/core/components/Copied'
import DownloadLink from '@supertask/modules/core/components/DownloadLink'
import Dropdown from '@supertask/modules/core/components/Dropdown'
import DropdownItem from '@supertask/modules/core/components/DropdownItem'
import DropdownSection from '@supertask/modules/core/components/DropdownSection'
import Editable from '@supertask/modules/core/components/Editable'
import Error from '@supertask/modules/core/components/Error'
import Expandable from '@supertask/modules/core/components/Expandable.vue'
import FormElement from '@supertask/modules/core/components/FormElement'
import FormGroup from '@supertask/modules/core/components/FormGroup'
import FormInput from '@supertask/modules/core/components/FormInput'
import FormRow from '@supertask/modules/core/components/FormRow'
import FormSection from '@supertask/modules/core/components/FormSection'
import FormTextarea from '@supertask/modules/core/components/FormTextarea'
import HelpIcon from '@supertask/modules/core/components/HelpIcon'
import Icon from '@supertask/modules/core/components/Icon'
import ImageInput from '@supertask/modules/core/components/ImageInput'
import List from '@supertask/modules/core/components/List'
import Logo from '@supertask/modules/core/components/Logo'
import MarkdownIt from '@supertask/modules/core/components/MarkdownIt'
import Modal from '@supertask/modules/core/components/Modal'
import Picker from '@supertask/modules/core/components/Picker'
import Presentation from '@supertask/modules/core/components/Presentation'
import ProgressBar from '@supertask/modules/core/components/ProgressBar'
import Radio from '@supertask/modules/core/components/Radio'
import RadioButton from '@supertask/modules/core/components/RadioButton'
import RadioCard from '@supertask/modules/core/components/RadioCard'
import RadioGroup from '@supertask/modules/core/components/RadioGroup'
import ReadOnlyForm from '@supertask/modules/core/components/ReadOnlyForm'
import Scrollbars from '@supertask/modules/core/components/Scrollbars'
import SegmentControl from '@supertask/modules/core/components/SegmentControl'
import SelectSearch from '@supertask/modules/core/components/SelectSearch'
import SwitchButton from '@supertask/modules/core/components/SwitchButton'
import SwitchInput from '@supertask/modules/core/components/SwitchInput'
import Tab from '@supertask/modules/core/components/Tab'
import Tabs from '@supertask/modules/core/components/Tabs'
import Thumbnail from '@supertask/modules/core/components/Thumbnail'
import autoOverflowScroll from '@supertask/modules/core/directives/autoOverflowScroll'
import autoScroll from '@supertask/modules/core/directives/autoScroll'
import clickOutside from '@supertask/modules/core/directives/clickOutside'
import preventParentScroll from '@supertask/modules/core/directives/preventParentScroll'
import scroll from '@supertask/modules/core/directives/scroll'
import sortable from '@supertask/modules/core/directives/sortable'
import tooltip from '@supertask/modules/core/directives/tooltip'
import userFileUpload from '@supertask/modules/core/directives/userFileUpload'

function setupVue(app) {
  app.component('Context', Context)
  app.component('Modal', Modal)
  app.component('Editable', Editable)
  app.component('Dropdown', Dropdown)
  app.component('DropdownSection', DropdownSection)
  app.component('DropdownItem', DropdownItem)
  app.component('Checkbox', Checkbox)
  app.component('Radio', Radio)
  app.component('RadioGroup', RadioGroup)
  app.component('RadioCard', RadioCard)
  app.component('Scrollbars', Scrollbars)
  app.component('Alert', Alert)
  app.component('Error', Error)
  app.component('SwitchInput', SwitchInput)
  app.component('Copied', Copied)
  app.component('MarkdownIt', MarkdownIt)
  app.component('DownloadLink', DownloadLink)
  app.component('FormElement', FormElement)
  app.component('Picker', Picker)
  app.component('ProgressBar', ProgressBar)
  app.component('Tab', Tab)
  app.component('Tabs', Tabs)
  app.component('List', List)
  app.component('HelpIcon', HelpIcon)
  app.component('Badge', Badge)
  app.component('BadgeCollaborator', BadgeCollaborator)
  app.component('Expandable', Expandable)
  app.component('Button', Button)
  app.component('ButtonText', ButtonText)
  app.component('ButtonFloating', ButtonFloating)
  app.component('ButtonAdd', ButtonAdd)
  app.component('ButtonIcon', ButtonIcon)
  app.component('Chips', Chips)
  app.component('RadioButton', RadioButton)
  app.component('Thumbnail', Thumbnail)
  app.component('Avatar', Avatar)
  app.component('Presentation', Presentation)
  app.component('FormInput', FormInput)
  app.component('FormTextarea', FormTextarea)
  app.component('CallToAction', CallToAction)
  app.component('FormGroup', FormGroup)
  app.component('FormRow', FormRow)
  app.component('ColorInput', ColorInput)
  app.component('ImageInput', ImageInput)
  app.component('SelectSearch', SelectSearch)
  app.component('Logo', Logo)
  app.component('ReadOnlyForm', ReadOnlyForm)
  app.component('FormSection', FormSection)
  app.component('SegmentControl', SegmentControl)
  app.component('SwitchButton', SwitchButton)
  app.component('Icon', Icon)

  app.directive('scroll', scroll)
  app.directive('preventParentScroll', preventParentScroll)
  app.directive('tooltip', tooltip)
  app.directive('sortable', sortable)
  app.directive('autoOverflowScroll', autoOverflowScroll)
  app.directive('userFileUpload', userFileUpload)
  app.directive('autoScroll', autoScroll)
  app.directive('clickOutside', clickOutside)

  app.config.globalProperties.$super = function (options) {
    return new Proxy(options, {
      get: (opts, name) => {
        if (opts.methods && name in opts.methods) {
          return opts.methods[name].bind(this)
        }
      },
    })
  }
}

export default defineNuxtPlugin((nuxtApp) => {
  setupVue(nuxtApp.vueApp)
})

export { setupVue }
