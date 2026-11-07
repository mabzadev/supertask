import { Registerable } from '@supertask/modules/core/registry'
import GenerateAIValuesContextItem from '@supertask_premium/components/field/GenerateAIValuesContextItem'

export class GenerateAIValuesContextItemType extends Registerable {
  static getType() {
    return 'generate_ai_values'
  }

  getComponent() {
    return GenerateAIValuesContextItem
  }
}
