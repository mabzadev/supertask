import {
  ensureString,
  ensureNumeric,
  ensureDateTime,
  ensureObject,
  ensureBoolean,
  ensureArray,
} from '@supertask/modules/core/utils/validator'
import moment from '@supertask/modules/core/moment'

export class SupertaskRuntimeFormulaArgumentType {
  constructor({ optional = false } = {}) {
    this.optional = optional
  }

  /**
   * This function tests if a given value is compatible with its type
   * @param value -  The value being tests
   * @returns {boolean} - If the value is of a valid type
   */
  test(value) {
    return true
  }

  /**
   * This function allows you to parse any given value to its type. This can be useful
   * if the argument is of the wrong type but can be parsed to the correct type.
   *
   * This can also be used to transform the data before it gets to the function call.
   *
   * @param value - The value that is being parsed
   * @returns {*} - The parsed value
   */
  parse(value) {
    return value
  }
}

export class NumberSupertaskRuntimeFormulaArgumentType extends SupertaskRuntimeFormulaArgumentType {
  constructor(options = {}) {
    super(options)
    this.castToInt = options.castToInt ?? false
    this.castToFloat = options.castToFloat ?? false
  }

  test(value) {
    if (value === undefined) {
      return false
    }

    try {
      ensureNumeric(value)
      return true
    } catch (e) {
      return false
    }
  }

  parse(value) {
    const val = ensureNumeric(value, { allowNull: true })
    if (this.castToInt) {
      return Math.trunc(val)
    } else if (this.castToFloat) {
      return parseFloat(val)
    }
    return val
  }
}

export class TextSupertaskRuntimeFormulaArgumentType extends SupertaskRuntimeFormulaArgumentType {
  test(value) {
    return typeof value.toString === 'function'
  }

  parse(value) {
    return ensureString(value)
  }
}

export class DateTimeSupertaskRuntimeFormulaArgumentType extends SupertaskRuntimeFormulaArgumentType {
  test(value) {
    if (value instanceof Date) {
      return true
    }
    try {
      ensureDateTime(value, { useStrict: false })
      return true
    } catch (e) {
      return false
    }
  }

  parse(value) {
    return ensureDateTime(value, { useStrict: false })
  }
}

export class ObjectSupertaskRuntimeFormulaArgumentType extends SupertaskRuntimeFormulaArgumentType {
  test(value) {
    if (value instanceof Object) {
      return true
    }

    try {
      ensureObject(value)
      return true
    } catch (e) {
      return false
    }
  }

  parse(value) {
    return ensureObject(value)
  }
}

export class ArraySupertaskRuntimeFormulaArgumentType extends SupertaskRuntimeFormulaArgumentType {
  test(value) {
    try {
      ensureArray(value)
      return true
    } catch (e) {
      return false
    }
  }

  parse(value) {
    return ensureArray(value)
  }
}

export class BooleanSupertaskRuntimeFormulaArgumentType extends SupertaskRuntimeFormulaArgumentType {
  test(value) {
    try {
      ensureBoolean(value, { useStrict: false })
      return true
    } catch (e) {
      return false
    }
  }

  parse(value) {
    return ensureBoolean(value, { useStrict: false })
  }
}

export class TimezoneSupertaskRuntimeFormulaArgumentType extends SupertaskRuntimeFormulaArgumentType {
  test(value) {
    if (value == null || typeof value.toString !== 'function') {
      return false
    }

    return moment.tz.names().includes(value)
  }

  parse(value) {
    return ensureString(value)
  }
}

export class AnySupertaskRuntimeFormulaArgumentType extends SupertaskRuntimeFormulaArgumentType {
  test(value) {
    return true
  }

  parse(value) {
    return value
  }
}
