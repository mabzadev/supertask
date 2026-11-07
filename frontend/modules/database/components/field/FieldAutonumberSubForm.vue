<script>
import form from '@supertask/modules/core/mixins/form'
import fieldSubForm from '@supertask/modules/database/mixins/fieldSubForm'

export default {
  name: 'FieldAutonumberSubForm',
  mixins: [form, fieldSubForm],
  setup() {
    return () => null
  },
  data() {
    return {
      allowedValues: ['view_id'],
      values: { view_id: null },
    }
  },
  methods: {
    getDefaultValues() {
      return {
        view_id: this.view.id,
      }
    },
  },
}
</script>
