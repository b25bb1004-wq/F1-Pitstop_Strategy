import pandas as pd
import glob
import os
files = glob.glob('../data/*.csv')
dfs = []
for f in files:
    df = pd.read_csv(f)
    circuit_name = os.path.basename(f).replace('.csv', '')
    df['location'] = circuit_name
    dfs.append(df)

all_data = pd.concat(dfs, ignore_index=True)
all_data['location'] = all_data['location'].replace({
    'Monte Carlo' : 'Monaco',
    'Miami Gardens' : 'Miami'
})

print(all_data.shape)
print(all_data[all_data['location'].isna()])
print(all_data['location'].unique())
print(all_data[all_data['location'].isna()]['year'].value_counts())
