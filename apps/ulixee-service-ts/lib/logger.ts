type LogLevel = 'ERROR' | 'WARN' | 'INFO' | 'DEBUG' | 'TRACE';

export class Logger {
  private static colors = {
    ERROR: "\x1b[31m%s\x1b[0m", // Red
    WARN: "\x1b[33m%s\x1b[0m",  // Yellow
    INFO: "\x1b[34m%s\x1b[0m",  // Blue
    DEBUG: "\x1b[36m%s\x1b[0m", // Cyan
    TRACE: "\x1b[35m%s\x1b[0m", // Magenta
  };

  private static currentLevel: LogLevel = 'INFO';

  private static formatMessage(message: string | any, ...args: any[]): string {
    if (typeof message !== 'string') {
      return JSON.stringify(message, null, 2);
    }
    
    if (args.length === 0) {
      return message;
    }

    // If there are additional arguments, format them and append
    const formattedArgs = args.map(arg => {
      if (arg instanceof Error) {
        return arg.stack || arg.message;
      }
      if (typeof arg === 'object') {
        return JSON.stringify(arg, null, 2);
      }
      return String(arg);
    });

    return `${message} ${formattedArgs.join(' ')}`;
  }

  private static log(message: string | any, level: LogLevel, ...args: any[]) {
    const levels: { [key in LogLevel]: number } = {
      ERROR: 0,
      WARN: 1,
      INFO: 2,
      DEBUG: 3,
      TRACE: 4,
    };

    if (levels[level] <= levels[this.currentLevel]) {
      const formattedMessage = this.formatMessage(message, ...args);
      console.log(this.colors[level], `[${level}] ${formattedMessage}`);
    }
  }

  static error(message: string | any, ...args: any[]) {
    this.log(message, 'ERROR', ...args);
  }

  static warn(message: string | any, ...args: any[]) {
    this.log(message, 'WARN', ...args);
  }

  static info(message: string | any, ...args: any[]) {
    this.log(message, 'INFO', ...args);
  }

  static debug(message: string | any, ...args: any[]) {
    this.log(message, 'DEBUG', ...args);
  }

  static trace(message: string | any, ...args: any[]) {
    this.log(message, 'TRACE', ...args);
  }

  static setLevel(level: LogLevel) {
    this.currentLevel = level;
  }
}
