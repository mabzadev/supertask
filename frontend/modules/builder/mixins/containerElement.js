import element from '@supertask/modules/builder/mixins/element'
import { DIRECTIONS } from '@supertask/modules/builder/enums'

export default {
  mixins: [element],
  computed: {
    DIRECTIONS: () => DIRECTIONS,
    children() {
      return this.$store.getters['element/getChildren'](
        this.elementPage,
        this.element
      )
    },
  },
}
