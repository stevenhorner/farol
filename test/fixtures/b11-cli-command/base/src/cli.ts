import { Command } from 'commander'
import { reportUsers } from './jobs/report'
import { syncBrands } from './jobs/sync'

const program = new Command('shop')

program
  .command('sync')
  .description('sync the brand catalog')
  .action(async () => {
    await syncBrands()
  })

program.command('report <format>').option('--out <file>').action(reportUsers)

program.parse()
